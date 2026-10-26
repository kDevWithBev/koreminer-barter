// Replays every close the v5.1 sim ran (fixtures/sim-v5.1-fixture.json, made by fixtures/export-sim-v5.1.py) through the
// real pit.mjs / ladder.mjs / share.mjs code and compares the full state after every step, plus each close's output.
// Offline. Run: node pit-check.mjs [fixture]
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Crash, closeDay, createPit, makeConfig, recover } from "./pit.mjs";

const path = process.argv[2] ?? new URL("./fixtures/sim-v5.1-fixture.json", import.meta.url).pathname;
const raw = readFileSync(path);
const fx = JSON.parse(raw);
const B = (v) => BigInt(v);
const bmap = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, B(v)]));

export function canon(x) {
  if (x === null || typeof x === "boolean" || typeof x === "string") return x;
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "number") { if (!Number.isInteger(x)) throw new Error(`non-integer ${x}`); return String(x); }
  if (x instanceof Set) return [...x].map(canon).sort();
  if (Array.isArray(x)) return x.map(canon);
  const out = {};
  for (const k of Object.keys(x).sort()) out[k] = canon(x[k]);
  return out;
}
function stateOf(p) {
  return canon({
    seen: [...p.seen].sort(), pending: p.pending, paid: p.paid, lots: p.lots, budget_total: p.budget_total, alloc_total: p.alloc_total,
    kept_total: p.kept_total, paid_total: p.paid_total, cutover_unissued: p.cutover_unissued, vault_start: p.vault_start, vault: p.vault,
    fee_gross: p.fee_gross, fee_gross_start: p.fee_gross_start, fee_spent: p.fee_spent, intents: p.intents, chain: p.chain, closed: p.closed,
    alloc: p.alloc, last_pit_closed: p.last_pit_closed, ladder: p.ladder, lmeta: p.lmeta, fee_quotes: p.fee_quotes, sent_hist: p.sent_hist,
    carry_run: p.carry_run, fee_low_alerted: p.fee_low_alerted, payouts: p.payouts, lev: p.lev, alerts: p.alerts, flags: p.flags, burns: p.burns,
  });
}
const NUMS = ["streak", "best", "shields", "used_run", "used_total", "shift_boss_grants", "missed_total"];
function pitFrom(s) {
  if (Object.keys(s.alloc).length || Object.keys(s.closed).length) throw new Error("fixture init with closed days is not supported");
  const p = createPit({});
  Object.assign(p, {
    seen: new Set(s.seen), pending: bmap(s.pending), paid: bmap(s.paid),
    lots: Object.fromEntries(Object.entries(s.lots).map(([w, l]) => [w, l.map(([d, n]) => [d, B(n)])])),
    budget_total: B(s.budget_total), alloc_total: B(s.alloc_total), kept_total: B(s.kept_total), paid_total: B(s.paid_total),
    cutover_unissued: B(s.cutover_unissued), vault_start: B(s.vault_start), vault: B(s.vault),
    fee_gross: s.fee_gross === null ? null : B(s.fee_gross), fee_gross_start: s.fee_gross_start === null ? null : B(s.fee_gross_start),
    fee_spent: bmap(s.fee_spent), intents: {}, chain: s.chain.map(([k, w, a, f, d]) => [k, w, B(a), B(f), d]),
    last_pit_closed: s.last_pit_closed,
    ladder: Object.fromEntries(Object.entries(s.ladder).map(([w, lw]) => [w, Object.fromEntries(Object.entries(lw).map(([k, v]) => [k, NUMS.includes(k) ? Number(v) : v]))])),
    lmeta: { ...s.lmeta }, fee_quotes: s.fee_quotes.map(B), sent_hist: s.sent_hist.map(Number), carry_run: Number(s.carry_run),
    fee_low_alerted: s.fee_low_alerted, payouts: s.payouts, lev: s.lev, alerts: s.alerts, flags: s.flags, burns: s.burns,
  });
  if (Object.keys(s.intents).length) throw new Error("fixture init with intents is not supported");
  return p;
}
function sendFrom(x) {
  const s = { tx: x.tx, time: x.time, timeMs: Date.parse(x.time), from: x.from, to: x.to, token: x.token, amount: B(x.amount) };
  if ("block" in x) { s.block = x.block; s.op = Number(x.op); }
  return s;
}
function firstDiff(a, b, at = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${at}.${k}`);
      if (d) return d;
    }
  }
  return `${at}: js=${JSON.stringify(a)?.slice(0, 200)} sim=${JSON.stringify(b)?.slice(0, 200)}`;
}

const cfg = makeConfig({ pitDay1: fx.constants.PIT_DAY_1, fire: fx.constants.FIRE, excluded: fx.constants.EXCLUDED });
let steps = 0; let bad = 0; const named = new Set();
for (const [i, st] of fx.streams.entries()) {
  const label = st.name || `scratch#${i}`;
  const p = pitFrom(st.init);
  let ok = true;
  for (const [j, step] of st.steps.entries()) {
    steps += 1;
    let out = null; let threw = null;
    try {
      if (step.op === "recover") out = recover(p);
      else {
        out = closeDay(cfg, p, step.day, step.sends.map(sendFrom), { testMode: step.test_mode, queue: step.queue, ladderOn: step.ladder_on, crash: step.crash });
      }
    } catch (err) {
      if (err instanceof Crash) threw = "Crash";
      else if (/ladder gap/.test(err.message)) threw = "Assert";
      else throw err;
    }
    if (step.op === "close" && threw !== step.threw) { ok = false; console.log(`FAIL ${label} step ${j} threw js=${threw} sim=${step.threw}`); break; }
    const d1 = step.out === null && out === null ? null : firstDiff(canon(out), step.out, "out");
    const d2 = firstDiff(stateOf(p), step.after, "state");
    if (d1 || d2) { ok = false; console.log(`FAIL ${label} step ${j} (${step.op} ${step.day ?? ""}) ${d1 ?? d2}`); break; }
  }
  if (!ok) bad += 1; else if (st.name) named.add(st.name);
}
const sha = createHash("md5").update(raw).digest("hex");
console.log(`fixture ${path} md5 ${sha} (sim md5 ${fx.sim_md5})`);
console.log(`streams ${fx.streams.length}, steps ${steps}, failing streams ${bad}`);
console.log(`named scenario streams matched: ${[...named].join(" ")}`);
console.log(`sim scenario results in fixture: ${Object.values(fx.results).filter(Boolean).length}/${Object.keys(fx.results).length} PASS`);
if (bad) { console.log("PIT_CHECK_FAIL"); process.exit(1); }
console.log("PIT_CHECK_PASS: every sim close and recovery replayed through pit.mjs with identical state and outputs");
