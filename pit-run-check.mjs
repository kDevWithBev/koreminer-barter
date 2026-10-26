// pit-run.mjs against a mocked Keeta client. Offline: nothing here reaches a network.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ADDR, closeDay, createPit, makeConfig, pitFromJson, ONE_KTA, FEE_RAW } from "./pit.mjs";
import { freshPit, runPit, readConfig } from "./pit-run.mjs";

const BASE = "keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg"; // stands in for the KTA token id
const SNAP = new URL("./fixtures/streak-snapshot-20261026T003137Z.json", import.meta.url).pathname;
const SNAP_MD5 = "47a2d78b84ab72c80bb4f21d763adff1";
const DAY1 = "2026-11-02";
const W = (n) => `keeta_aab${String(n).repeat(48).slice(0, 48)}wxyz${n}`.slice(0, 70);
const W1 = W(1); const W2 = W(2); const W3 = W(3);
const K = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n; // KTA raw, 18 dp
let failed = 0;
function check(name, ok, extra = "") { console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` - ${extra}` : ""}`); if (!ok) failed += 1; }

function mockClient({ kta = 10n * ONE_KTA, kore = 20_000_000n, fee = FEE_RAW, staples = [], crash = null } = {}) {
  const c = { kta, kore, published: [], staples, crash, fee, pending: null };
  const tok = (t) => (typeof t === "string" ? t : t?.publicKeyString?.toString?.() ?? "");
  c.getHistory = async (account, { startBlocksHash } = {}) => {
    if (account !== ADDR.sink) throw new Error("history of the wrong account");
    const rows = [...c.staples].sort((a, b) => b.t - a.t).map((s) => ({
      voteStaple: { blocksHash: { toString: () => s.hash }, timestamp: () => new Date(s.t), blocks: s.blocks },
    }));
    if (!startBlocksHash) return rows.slice(0, 100);
    const i = rows.findIndex((r) => r.voteStaple.blocksHash.toString() === startBlocksHash);
    return rows.slice(i + 1, i + 101);
  };
  c.balance = async (t) => (tok(t) === BASE ? c.kta : c.kore);
  c.pendingBlock = async () => c.pending;
  c.initBuilder = () => {
    const ops = [];
    return {
      ops,
      send(dest, amount, token, external) { ops.push({ type: 0, to: dest, amount, token, external }); },
      async computeBlocks() { return { blocks: [{ operations: ops }] }; },
      async computeFeeBlock(staple) { return { operations: [{ type: 0, token: BASE, amount: staple.votes[0].fee.amount }] }; },
    };
  };
  c.getQuotes = async () => [{ fee: { amount: c.fee, token: BASE } }];
  c.publishBuilder = async (builder, { generateFeeBlock }) => {
    if (c.crash === "before") { c.crash = null; throw new Error("socket closed before publish"); }
    const feeBlock = await generateFeeBlock({ votes: [{ fee: { amount: c.fee, token: BASE } }] });
    const op = builder.ops[0];
    c.kore -= op.amount; c.kta -= feeBlock.operations[0].amount;
    c.published.push({ to: op.to, amount: op.amount, key: op.external });
    if (c.crash === "after") { c.crash = null; throw new Error("socket closed after publish"); }
    return { publish: true };
  };
  return c;
}
let hashN = 0;
function staple(time, blocks) {
  hashN += 1;
  return { hash: `S${hashN}`, t: Date.parse(time), blocks: blocks.map((b, i) => ({ account: b.from, hash: `B${hashN}-${i}`, operations: b.ops.map((o) => ({ type: 0, to: o.to ?? ADDR.sink, token: o.token, amount: o.amount })) })) };
}
function setup(cfgExtra = {}) {
  const dir = mkdtempSync(`${tmpdir()}/pit-run-`);
  writeFileSync(`${dir}/pit-config.json`, JSON.stringify({ pitDay1: DAY1, ladderSeed: SNAP, ladderSeedMd5: SNAP_MD5, publicDir: `${dir}/www`, ...cfgExtra }));
  return dir;
}
const quiet = process.env.PIT_VERBOSE ? {} : { log: () => {}, warn: () => {} };
const accountFrom = (id) => id;
const koreAccount = ADDR.kore;
function clock(iso) { let t = Date.parse(iso); return { now: () => t, sleep: async (ms) => { t += ms; } }; }
const stateOf = (dir, sub = "") => pitFromJson(readFileSync(`${dir}${sub}/pit-state.json`, "utf8"));

// Day 1 traffic. The steering scenario: aabz6zxb sends 1 KORE + 0.01 USDC in the same block/staple as W1's ticket.
function day1() {
  return [
    staple(`${DAY1}T01:00:00.000Z`, [
      { from: W1, ops: [{ token: BASE, amount: K(3) }] },
      { from: ADDR.testB, ops: [{ token: ADDR.kore, amount: 1n }, { token: ADDR.usdc, amount: 10_000n }] },
    ]),
    staple(`${DAY1}T02:00:00.000Z`, [{ from: W2, ops: [{ token: BASE, amount: K(1) }, { token: ADDR.kore, amount: 5n }] }]),
    staple(`${DAY1}T03:00:00.000Z`, [{ from: ADDR.hd2i, ops: [{ token: BASE, amount: K(2) }] }]),
    staple(`${DAY1}T04:00:00.000Z`, [{ from: ADDR.testB, ops: [{ token: BASE, amount: K(12) }] }]),
    staple(`${DAY1}T05:00:00.000Z`, [{ from: W3, ops: [{ token: BASE, amount: K(0.5) }] }]),
    staple(`${DAY1}T06:00:00.000Z`, [{ from: W3, ops: [{ token: BASE, amount: K(4), to: ADDR.intake }] }]),
  ];
}

// ---- 1. live close, compared with the pure pit.mjs close over the same sends ----
{
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const client = mockClient({ staples: day1() });
  const { now, sleep } = clock(`${DAY1}T23:59:00.000Z`);
  await runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now, sleep, steps: 1, ...quiet });
  check("1a no close before the day ends + grace", !existsSync(`${dir}/pit-state.json`) || !stateOf(dir).closed[DAY1]);
  await runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep, steps: 1, ...quiet });
  const pit = stateOf(dir);
  const row = pit.closed[DAY1];
  check("1b day 1 closed once", !!row && pit.last_pit_closed === DAY1);
  // Pure model over the same sends, same fee.
  const cfg = makeConfig({ pitDay1: DAY1 });
  const ref = freshPit({ ...readConfig(dir) });
  ref.fee_gross = 10n * ONE_KTA;
  const sends = [];
  for (const s of day1()) for (const b of s.blocks) b.operations.forEach((o, i) => sends.push({ tx: b.hash, block: b.hash, op: i, from: b.account, to: o.to, token: o.token === BASE ? "KTA" : o.token === ADDR.kore ? "KORE" : o.token, amount: o.amount, time: new Date(s.t).toISOString(), timeMs: s.t }));
  // Block hashes differ between the two builds (hashN), so compare money fields, not seen keys.
  closeDay(cfg, ref, DAY1, sends, {});
  const money = (p) => JSON.stringify({ pending: p.pending, paid: p.paid, alloc_total: p.alloc_total, kept: p.kept_total, ladder: p.ladder, burns: p.burns.map((b) => [b.from, b.token, b.amount_raw, b.kind]) }, (k, v) => (typeof v === "bigint" ? String(v) : v));
  check("1c runner close == pit.mjs closeDay (pending, paid, kept, ladder, burns)", money(pit) === money(ref));
  const burns = pit.burns.map((b) => `${b.from.slice(0, 14)}:${b.token === ADDR.usdc ? "USDC" : b.token}:${b.amount_raw}:${b.kind}`);
  check("1d aabz6zxb's KORE + USDC and W2's KORE logged as burns only", burns.length === 3 && burns.filter((b) => b.startsWith(ADDR.testB.slice(0, 14))).length === 2, burns.join(" "));
  check("1e W1's ticket in the same staple still counts", pit.alloc[DAY1].miners[W1] === K(3));
  const snap = JSON.parse(readFileSync(SNAP, "utf8")).wallets[ADDR.testB];
  check("1f aabz6zxb frozen streak unchanged", pit.ladder[ADDR.testB].frozen === true && pit.ladder[ADDR.testB].streak === snap.mining_streak, `streak ${pit.ladder[ADDR.testB].streak}`);
  check("1g aabz6zxb's 12 KTA excluded, never paid", !(ADDR.testB in pit.pending) && !client.published.some((p) => p.to === ADDR.testB));
  check("1h hd2i counts", pit.alloc[DAY1].miners[ADDR.hd2i] === K(2) && pit.paid[ADDR.hd2i] > 0n);
  const reasons = pit.alloc[DAY1].ignored.map((r) => r.reason).sort().join(",");
  check("1i sub-1 and wrong-address sends ignored", reasons.includes("sub_1") && !reasons.includes("counted"), reasons);
  check("1j whole KORE, one send per wallet, totals match", client.published.length === 3 && client.published.every((p) => typeof p.amount === "bigint") &&
    client.published.reduce((a, p) => a + p.amount, 0n) === Object.values(pit.paid).reduce((a, v) => a + v, 0n));
  check("1k published keys are the intent keys", client.published.every((p) => pit.intents[p.key]?.status === "sent"));
  const lookup = JSON.parse(readFileSync(`${dir}/www/lookup.json`, "utf8"));
  check("1l public lookup hides aabz6zxb, aabt2kig, shaft and fire", ![ADDR.testA, ADDR.testB, ADDR.intake, ADDR.sink].some((w) => w in lookup.miners) && W1 in lookup.miners);
  const ladder = JSON.parse(readFileSync(`${dir}/www/barter/ladder.json`, "utf8"));
  check("1m public ladder hides aabz6zxb", !ladder.wallets.some((r) => r.wallet.endsWith("bbvy")) && ladder.wallets.some((r) => r.wallet.endsWith("hd2i")));
  check("1n lookup carries the new card fields", ["ktaToday", "shareToday", "carried", "paid", "waiting", "streak"].every((k) => k in lookup.miners[W1]));
  check("1o not stamped TEST", !lookup.test && !readFileSync(`${dir}/pit-days.csv`, "utf8").includes("TEST"));
  // 1p: a re-run of the same day does nothing.
  const before = client.published.length;
  await runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T05:00:00Z"), sleep, steps: 2, ...quiet });
  check("1p restart after the close sends nothing again", client.published.length === before && Object.keys(stateOf(dir).closed).length === 1);
  rmSync(dir, { recursive: true });
}

// ---- 2. crash after publish: restart writes the state once, never sends twice ----
{
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const client = mockClient({ staples: day1(), crash: "after" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => t, sleep: async () => {}, steps: 1, ...quiet });
  const mid = stateOf(dir);
  const open = Object.values(mid.intents).filter((i) => i.status === "intent");
  check("2a crash after publish leaves one open intent, day not closed", open.length === 1 && !mid.closed[DAY1], `${open.length}`);
  await runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => t + 60_000, sleep: async () => {}, steps: 1, ...quiet });
  const end = stateOf(dir);
  const keys = client.published.map((p) => p.key);
  check("2b restart: landed send applied once, no key sent twice, day closed", new Set(keys).size === keys.length && keys.length === 3 && !!end.closed[DAY1] && end.chain.length === 3);
  rmSync(dir, { recursive: true });
}

// ---- 3. send not published: voided only after expiry, then paid once ----
{
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const client = mockClient({ staples: day1(), crash: "before" });
  let t = Date.parse("2026-11-03T00:11:00Z");
  const run = () => runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => t, sleep: async () => {}, steps: 1, ...quiet });
  await run();
  check("3a failed publish keeps the intent open", Object.values(stateOf(dir).intents).filter((i) => i.status === "intent").length === 1 && client.published.length === 0);
  t += 60_000; await run();
  check("3b not voided before the 6 min expiry", Object.values(stateOf(dir).intents).filter((i) => i.status === "intent").length === 1 && client.published.length === 0);
  t += 7 * 60_000; await run();
  const p = stateOf(dir);
  const feeOnChain = p.chain.reduce((a, c) => a + c[3], 0n);
check("3c after expiry: voided, fee reservation released, then paid once per wallet", p.fee_spent[DAY1] === feeOnChain && client.published.length === 3 && new Set(client.published.map((x) => x.key)).size === 3 && !!p.closed[DAY1], `fee_spent ${p.fee_spent[DAY1]} chain ${feeOnChain}`);
  rmSync(dir, { recursive: true });
}

// ---- 4. fee low: stop once, one alert, no HALT; the 2 KTA reserve is never spent ----
{
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const d2 = "2026-11-03";
  const st = [...day1(), staple(`${d2}T01:00:00.000Z`, [{ from: W1, ops: [{ token: BASE, amount: K(2) }] }])];
  const client = mockClient({ staples: st, kta: 2n * ONE_KTA + 5_000_000_000_000_000n });
  await runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-04T00:11:00Z"), sleep: async () => {}, steps: 1, ...quiet });
  const p = stateOf(dir);
  const lows = p.alerts.filter((a) => a[1] === "ALERT_FEE_LOW");
  check("4a two closes, one ALERT_FEE_LOW, status fee_low, no HALT", !!p.closed[DAY1] && !!p.closed[d2] && lows.length === 1 && p.closed[DAY1].close_status === "fee_low" && !existsSync(`${dir}/HALT`), `alerts ${lows.length}`);
  check("4b reserve kept", client.kta >= 2n * ONE_KTA && client.published.length === 1, `kta ${client.kta}`);
  check("4c alert written to pit-alerts.log once", readFileSync(`${dir}/pit-alerts.log`, "utf8").split("\n").filter((l) => l.includes("ALERT_FEE_LOW")).length === 1);
  rmSync(dir, { recursive: true });
}

// ---- 5. test mode: separate state, TEST stamps, nothing published, no public copy ----
{
  const dir = setup({ test: true });
  writeFileSync(`${dir}/SEND`, "on\n");
  const client = mockClient({ staples: day1() });
  await runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1, ...quiet });
  const p = stateOf(dir, "/pit-test");
  check("5a test state in pit-test/, none in dir", existsSync(`${dir}/pit-test/pit-state.json`) && !existsSync(`${dir}/pit-state.json`));
  check("5b nothing published, no public copy", client.published.length === 0 && !existsSync(`${dir}/www/lookup.json`));
  check("5c outputs stamped TEST", readFileSync(`${dir}/pit-test/pit-days.csv`, "utf8").includes("TEST") && JSON.parse(readFileSync(`${dir}/pit-test/pit-lookup.json`, "utf8")).test === "TEST");
  check("5d test wallet's 12 KTA counts in test mode; frozen streak still unchanged", p.alloc[DAY1].miners[ADDR.testB] === K(12) && p.ladder[ADDR.testB].streak === JSON.parse(readFileSync(SNAP, "utf8")).wallets[ADDR.testB].mining_streak);
  rmSync(dir, { recursive: true });
}

// ---- 6. start time, config fail-closed, SEND off ----
{
  const dir = setup({ startTime: `${DAY1}T02:30:00.000Z` });
  const client = mockClient({ staples: day1() });
  await runPit({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1, ...quiet });
  const p = stateOf(dir);
  check("6a sends before startTime are not counted", !(W1 in p.alloc[DAY1].miners) && p.alloc[DAY1].miners[ADDR.hd2i] === K(2));
  check("6b SEND off: day closes, nothing published, KORE stays due", client.published.length === 0 && p.closed[DAY1].close_status === "send_off" && p.pending[ADDR.hd2i] > 0n);
  rmSync(dir, { recursive: true });
  let threw = false;
  const bad = setup({ pitDay1: undefined });
  try { readConfig(bad); } catch { threw = true; }
  check("6c missing pit day 1 fails closed", threw);
  threw = false;
  const bad2 = setup({ ladderSeedMd5: "0".repeat(32) });
  try { await runPit({ dir: bad2, client, base: BASE, baseText: BASE, koreAccount, accountFrom, steps: 1, ...quiet }); } catch { threw = true; }
  check("6d wrong ladder snapshot md5 refuses to start", threw);
}

// ---- 7. Tuesday dry run (2026-10-27 UTC) with the package configs (Trey 2026-10-26 11:38 ET: pitDay1 2026-10-29) ----
{
  const TUE = "2026-10-27";
  const tue = () => [
    staple(`${TUE}T14:00:00.000Z`, [
      { from: W1, ops: [{ token: BASE, amount: K(1) }] },
      { from: ADDR.testB, ops: [{ token: ADDR.kore, amount: 1n }, { token: ADDR.usdc, amount: 10_000n }] },
    ]),
    staple(`${TUE}T15:00:00.000Z`, [{ from: ADDR.testB, ops: [{ token: BASE, amount: K(1) }] }]),
  ];
  const after = () => Date.parse("2026-10-28T00:11:00Z");
  const a = setup({ test: true, pitDay1: "2026-10-29" });
  const ca = mockClient({ staples: tue() });
  await runPit({ dir: a, client: ca, base: BASE, baseText: BASE, koreAccount, accountFrom, now: after, sleep: async () => {}, steps: 1, ...quiet });
  const pa = stateOf(a, "/pit-test");
  const sa = JSON.parse(readFileSync(`${a}/pit-test/pit-sends.json`, "utf8"));
  check("7a test config with pitDay1 10-29: Tuesday closes no day and logs no Tuesday sends", Object.keys(pa.closed).length === 0 && !pa.alloc[TUE] && !(sa.byDay ?? {})[TUE] && ca.published.length === 0);
  rmSync(a, { recursive: true });
  const b = setup({ test: true, pitDay1: TUE });
  const cb = mockClient({ staples: tue() });
  await runPit({ dir: b, client: cb, base: BASE, baseText: BASE, koreAccount, accountFrom, now: after, sleep: async () => {}, steps: 1, ...quiet });
  const pb = stateOf(b, "/pit-test");
  check("7b test config with pitDay1 10-27: Tuesday closes at 00:10Z, exactly 1 KTA counts, burns logged, nothing published", !!pb.closed[TUE] && pb.alloc[TUE].miners[W1] === K(1) && pb.alloc[TUE].miners[ADDR.testB] === K(1) && pb.burns.filter((x) => x.from === ADDR.testB).length === 2 && cb.published.length === 0 && !existsSync(`${b}/pit-state.json`) && !existsSync(`${b}/www/lookup.json`));
  // Go-live afterwards: replace pit-config.json with the live file. Live state starts fresh in dir; pit-test/ is left alone.
  writeFileSync(`${b}/pit-config.json`, JSON.stringify({ pitDay1: "2026-10-29", ladderSeed: SNAP, ladderSeedMd5: SNAP_MD5, publicDir: `${b}/www` }));
  const before = readFileSync(`${b}/pit-test/pit-state.json`, "utf8");
  await runPit({ dir: b, client: cb, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-10-28T12:00:00Z"), sleep: async () => {}, steps: 1, ...quiet });
  const pl = stateOf(b);
  check("7c switch to live config: fresh live state, no Tuesday carry-over, test state untouched", Object.keys(pl.closed).length === 0 && !pl.alloc[TUE] && Object.keys(pl.pending).length === 0 && readFileSync(`${b}/pit-test/pit-state.json`, "utf8") === before && cb.published.length === 0);
  rmSync(b, { recursive: true });
}

console.log(failed ? `PIT_RUN_CHECK_FAIL ${failed}` : "PIT_RUN_CHECK_PASS");
process.exit(failed ? 1 : 0);
