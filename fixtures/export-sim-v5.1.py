#!/usr/bin/env python3
"""Record every close the v5.1 sim runs (inputs + full state after each step) as a JSON fixture for pit-check.mjs.
Box-only, offline. Imports the pinned sim (md5-checked) and wraps St / run_day / recover. Writes outputs to a scratch dir."""
import importlib.util, json, os, sys, hashlib
SIM = "/workspace/requests/koreminer/2026-10-26-sim-v5.1.py"
SIM_MD5 = sys.argv[1] if len(sys.argv) > 1 else None
os.environ["SIM_V51_OUT"] = "/tmp/kr8-sim-scratch"
got = hashlib.md5(open(SIM, "rb").read()).hexdigest()
if SIM_MD5 and got != SIM_MD5: sys.exit(f"sim md5 {got} != {SIM_MD5}")
spec = importlib.util.spec_from_file_location("sim", SIM); sim = importlib.util.module_from_spec(spec); spec.loader.exec_module(sim)

def canon(x):
    if isinstance(x, bool) or x is None: return x
    if isinstance(x, int): return str(x)
    if isinstance(x, str): return x
    if isinstance(x, (list, tuple)): return [canon(v) for v in x]
    if isinstance(x, (set, frozenset)): return sorted(canon(v) for v in x)
    if isinstance(x, dict): return {str(k): canon(v) for k, v in sorted(x.items(), key=lambda kv: str(kv[0]))}
    raise TypeError(type(x))
def state(st):
    return canon({"seen": sorted(f"{b}:{o}" for b, o in st.seen), "pending": st.pending, "paid": st.paid, "lots": st.lots,
        "budget_total": st.budget_total, "alloc_total": st.alloc_total, "kept_total": st.kept_total, "paid_total": st.paid_total,
        "cutover_unissued": st.cutover_unissued, "vault_start": st.vault_start, "vault": st.vault, "fee_gross": st.fee_gross,
        "fee_gross_start": st.fee_gross_start, "fee_spent": st.fee_spent, "intents": st.intents, "chain": st.chain, "closed": st.closed,
        "alloc": st.alloc, "last_pit_closed": st.last_pit_closed, "ladder": st.ladder, "lmeta": st.lmeta, "fee_quotes": st.fee_quotes,
        "sent_hist": st.sent_hist, "carry_run": st.carry_run, "fee_low_alerted": st.fee_low_alerted, "payouts": st.payouts,
        "lev": st.lev, "alerts": st.alerts, "flags": st.flags, "burns": st.burns})
streams = {}; order = []; KEEP = []
def stream(st):
    k = id(st)
    if k not in streams:
        streams[k] = {"init": state(st), "steps": []}; order.append(k); KEEP.append(st)   # hold a ref so ids are never reused
    return streams[k]
orig_run_day, orig_recover = sim.run_day, sim.recover
def run_day(st, day, sends, test_mode=False, queue="fifo", ladder_on=True, crash=None):
    s = stream(st)
    step = {"op": "close", "day": day, "sends": canon(sends), "test_mode": test_mode, "queue": queue, "ladder_on": ladder_on, "crash": canon(crash)}
    try:
        out = orig_run_day(st, day, sends, test_mode=test_mode, queue=queue, ladder_on=ladder_on, crash=crash)
        step["out"] = canon({k: v for k, v in out.items()}); step["threw"] = None
    except sim.Crash as e:
        step["out"] = None; step["threw"] = "Crash"
    except AssertionError as e:
        step["out"] = None; step["threw"] = "Assert"
    step["after"] = state(st); s["steps"].append(step)
    if step["threw"] == "Crash": raise sim.Crash("replayed")
    if step["threw"] == "Assert": raise AssertionError("replayed")
    return out
def recover(st):
    s = stream(st); out = orig_recover(st)
    s["steps"].append({"op": "recover", "out": canon(out), "after": state(st)}); return out
sim.run_day = run_day; sim.recover = recover
R = sim.main()
results = {r["id"]: r["ok"] for r in R["results"]}
names = {id(v): k for k, v in R["states"].items()}     # scenario names the sim recorded; others are scratch / hand-built runs
fx = {"sim": SIM, "sim_md5": got, "results": results, "streams": [dict(streams[k], name=names.get(k, "")) for k in order],
      "constants": canon({"PIT_DAY_1": sim.PIT_DAY_1, "FIRE": sim.FIRE, "EXCLUDED": sorted(sim.EXCLUDED), "TEST_WALLETS": sorted(sim.TEST_WALLETS),
                          "FROZEN": sorted(sim.FROZEN), "seed_ladder": sim.seed_ladder()})}
out = sys.argv[2] if len(sys.argv) > 2 else "/workspace/kr8/fixtures/sim-v5.1-fixture.json"
json.dump(fx, open(out, "w"), separators=(",", ":"))
print("streams", len(fx["streams"]), "steps", sum(len(s["steps"]) for s in fx["streams"]), "results", sum(results.values()), "/", len(results), "md5", hashlib.md5(open(out, "rb").read()).hexdigest())
