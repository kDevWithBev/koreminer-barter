// pit-run.mjs against a mocked Keeta client. Offline: nothing here reaches a network.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { ADDR, allocate, budgetOf, closeDay, createPit, makeConfig, pitFromJson, pitToJson, ONE_KTA, FEE_RAW, DAY_CAP } from "./pit.mjs";
import { judgeIntent } from "./pay.mjs";
import { freshPit, runPit, readConfig, publicViews } from "./pit-run.mjs";

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
  const c = { kta, kore, published: [], staples, crash, fee, pending: null, now: () => { throw new Error("mock clock not set"); }, feeBad: false, intakeStuck: false, genesis: true, voteFee: null };
  // Ops B-1: a real shaft and fire address have history from long before any pitDay1; the mock ends each history with one
  // old row so a full walk can prove it reached the start. genesis = false models a node that returns a truncated history.
  const old = (acct) => ({ voteStaple: { blocksHash: { toString: () => `G-${acct.slice(6, 12)}` }, timestamp: () => new Date("2025-01-01T00:00:00Z"), blocks: [] } });
  const tok = (t) => (typeof t === "string" ? t : t?.publicKeyString?.toString?.() ?? "");
  const page = (rows, startBlocksHash) => {
    if (!startBlocksHash) return rows.slice(0, 100);
    const i = rows.findIndex((r) => r.voteStaple.blocksHash.toString() === startBlocksHash);
    return rows.slice(i + 1, i + 101);
  };
  // Shaped like the real UserClient (keetanet-client 0.18.7): no top-level getHistory, other accounts via c.client.getHistory.
  c._history = async (account, { startBlocksHash } = {}) => {
    if (account === ADDR.intake) { // the shaft's own KORE payouts, with their external keys (Ops R-B1)
      if (c.intakeStuck) return Array.from({ length: 100 }, (_, i) => ({ voteStaple: { blocksHash: { toString: () => "STUCK" }, timestamp: () => new Date(c.now()), blocks: [] } }));
      return page(c.intakeRows().slice(c.historyLag ?? 0), startBlocksHash); // historyLag: a rep that serves an old prefix
    }
    if (account !== ADDR.sink) throw new Error("history of the wrong account");
    const rows = [...c.staples].sort((a, b) => b.t - a.t).map((s) => ({
      voteStaple: { blocksHash: { toString: () => s.hash }, timestamp: () => new Date(s.t), blocks: s.blocks },
    }));
    if (c.genesis) rows.push(old(account));
    return page(rows, startBlocksHash);
  };
  // Ops R-1: the shaft's blocks are a hash chain (each block's previous is the next older one), down to an old shaft block
  // from before any pitDay1, as on mainnet (fee block + payout block per staple there; one block here is enough).
  c.intakeRows = () => {
    const rows = [...c.published].map((p, i) => ({ ...p, i })).sort((a, b) => b.t - a.t || b.i - a.i).map((p) => ({
      voteStaple: { blocksHash: { toString: () => `P${p.i}` }, timestamp: () => new Date(p.t), blocks: [{ account: ADDR.intake, hash: `PB${p.i}`, operations: [{ type: 0, to: p.to, token: ADDR.kore, amount: p.amount, external: p.key }] }] },
    }));
    if (c.genesis) rows.push({ voteStaple: { blocksHash: { toString: () => "G-shaft" }, timestamp: () => new Date("2025-01-01T00:00:00Z"), blocks: [{ account: ADDR.intake, hash: "GB-shaft", previous: "GB-older", operations: [] }] } });
    rows.forEach((r, k) => { const b = r.voteStaple.blocks[0]; if (k + 1 < rows.length && b.previous === undefined) b.previous = rows[k + 1].voteStaple.blocks[0].hash; });
    return rows;
  };
  // Every rep reports the shaft head (the newest block of the full chain); c.repHeads overrides one rep's answer (lag).
  c.repHeads = {};
  const reps = [{ endpoints: { api: "rep1" } }, { endpoints: { api: "rep2" } }, { endpoints: { api: "rep3" } }, { endpoints: { api: "rep4" } }]; // the SDK's 4 mainnet reps
  c.client = {
    getHistory: (account, opts) => c._history(account, opts),
    get representatives() { return c.noReps ? [] : c.oneRep ? reps.slice(0, 1) : reps; },
    getAccountHeadInfo: async (account, rep) => {
      if (account !== ADDR.intake) throw new Error("head of the wrong account");
      const api = rep?.endpoints?.api;
      if (c.repHeads[api] === "error") throw new Error("rep down");
      const h = c.repHeads[api] ?? c.intakeRows()[0]?.voteStaple.blocks[0].hash;
      return h ? { block: { hash: h }, height: 1n } : null;
    },
  };
  c.balance = async (t) => { if (c.failBalance) { c.failBalance -= 1; throw new Error("balance read failed"); } return tok(t) === BASE ? c.kta : c.kore; };
  c.pendingBlock = async () => c.pending;
  c.initBuilder = () => {
    const ops = [];
    return {
      ops,
      send(dest, amount, token, external) { ops.push({ type: 0, to: dest, amount, token, external }); },
      async computeBlocks() { return { blocks: [{ operations: ops }] }; },
      async computeFeeBlock(staple) { return { operations: [{ type: 0, token: BASE, amount: staple.votes[0].fee.amount + (c.feeBad ? 1n : 0n) }] }; },
    };
  };
  c.getQuotes = async () => [{ fee: { amount: c.fee, token: BASE } }];
  c.publishBuilder = async (builder, { generateFeeBlock }) => {
    if (c.crash === "before") { c.crash = null; throw new Error("socket closed before publish"); }
    let feeBlock;
    try { feeBlock = await generateFeeBlock({ votes: [{ fee: { amount: c.voteFee ?? c.fee, token: BASE } }] }); } finally { c.feeBad = false; }
    const op = builder.ops[0];
    c.kore -= op.amount; c.kta -= feeBlock.operations[0].amount;
    c.published.push({ to: op.to, amount: op.amount, key: op.external, t: c.now(), fee: feeBlock.operations[0].amount });
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
function init(dir, pitDay1, mode, extra = {}) { writeFileSync(`${dir}/pit-init`, JSON.stringify({ pitDay1, mode, ...extra })); }
function setup(cfgExtra = {}) {
  const dir = mkdtempSync(`${tmpdir()}/pit-run-`);
  writeFileSync(`${dir}/pit-config.json`, JSON.stringify({ pitDay1: DAY1, ladderSeed: SNAP, ladderSeedMd5: SNAP_MD5, publicDir: `${dir}/www`, ...cfgExtra }));
  init(dir, cfgExtra.pitDay1 ?? DAY1, cfgExtra.test ? "test" : "live"); // Ops R-B3: the one-time init file Trey creates
  return dir;
}
// Scenarios 1-7 test other things than pacing, so they run with no publish gap (the other pace limits stay on).
// Scenario 10 runs the real pace.
function rp(o) { o.client.now = o.now ?? (() => Date.now()); return runPit({ pace: { gapMs: 0 }, ...o }); }
const quiet = process.env.PIT_VERBOSE ? {} : { log: () => {}, warn: () => {} };
const accountFrom = (id) => id;
const koreAccount = ADDR.kore;
function clock(iso) { let t = Date.parse(iso); return { now: () => t, sleep: async (ms) => { t += ms; }, set: (x) => { t = typeof x === "number" ? x : Date.parse(x); }, add: (ms) => { t += ms; } }; }
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
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now, sleep, steps: 1, ...quiet });
  check("1a no close before the day ends + grace", !existsSync(`${dir}/pit-state.json`) || !stateOf(dir).closed[DAY1]);
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep, steps: 1, ...quiet });
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
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T05:00:00Z"), sleep, steps: 2, ...quiet });
  check("1p restart after the close sends nothing again", client.published.length === before && Object.keys(stateOf(dir).closed).length === 1);
  rmSync(dir, { recursive: true });
}

// ---- 2. crash after publish: restart writes the state once, never sends twice ----
{
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const client = mockClient({ staples: day1(), crash: "after" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => t, sleep: async () => {}, steps: 1, ...quiet });
  const mid = stateOf(dir);
  const open = Object.values(mid.intents).filter((i) => i.status === "intent");
  check("2a crash after publish leaves one open intent, day not closed", open.length === 1 && !mid.closed[DAY1], `${open.length}`);
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => t + 60_000, sleep: async () => {}, steps: 1, ...quiet });
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
  const run = () => rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => t, sleep: async () => {}, steps: 1, ...quiet });
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
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-04T00:11:00Z"), sleep: async () => {}, steps: 1, ...quiet });
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
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1, ...quiet });
  const p = stateOf(dir, "/pit-test");
  check("5a test state in pit-test/, none in dir", existsSync(`${dir}/pit-test/pit-state.json`) && !existsSync(`${dir}/pit-state.json`));
  check("5b nothing published, no public copy", client.published.length === 0 && !existsSync(`${dir}/www/lookup.json`));
  check("5c outputs stamped TEST", readFileSync(`${dir}/pit-test/pit-days.csv`, "utf8").includes("TEST") && JSON.parse(readFileSync(`${dir}/pit-test/pit-lookup.json`, "utf8")).test === "TEST");
  check("5d test wallet's 12 KTA counts in test mode; frozen streak still unchanged", p.alloc[DAY1].miners[ADDR.testB] === K(12) && p.ladder[ADDR.testB].streak === JSON.parse(readFileSync(SNAP, "utf8")).wallets[ADDR.testB].mining_streak);
  rmSync(dir, { recursive: true });
}

// ---- 6. start time, config fail-closed, SEND off ----
{
  // S3: a later startTime is only allowed in test mode now.
  const dir = setup({ startTime: `${DAY1}T02:30:00.000Z`, test: true });
  const client = mockClient({ staples: day1() });
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1, ...quiet });
  const p = stateOf(dir, "/pit-test");
  check("6a (test mode) sends before startTime are not counted", !(W1 in p.alloc[DAY1].miners) && p.alloc[DAY1].miners[ADDR.hd2i] === K(2));
  rmSync(dir, { recursive: true });
  const dirB = setup();
  const clientB = mockClient({ staples: day1() });
  await rp({ dir: dirB, client: clientB, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1, ...quiet });
  const pB = stateOf(dirB);
  check("6b SEND off: day closes, nothing published, KORE stays due", clientB.published.length === 0 && pB.closed[DAY1].close_status === "send_off" && pB.pending[ADDR.hd2i] > 0n);
  rmSync(dirB, { recursive: true });
  let threwS3 = false;
  const s3 = setup({ startTime: `${DAY1}T02:30:00.000Z` });
  try { readConfig(s3); } catch (e) { threwS3 = /live mode: startTime/.test(e.message); }
  check("6e S3: live mode refuses a startTime that is not pitDay1 00:00Z", threwS3);
  const s3b = setup({ startTime: `${DAY1}T00:00:00.000Z` });
  check("6f S3: live startTime exactly pitDay1 00:00Z is accepted", readConfig(s3b).startMs === Date.parse(`${DAY1}T00:00:00Z`));
  rmSync(s3, { recursive: true }); rmSync(s3b, { recursive: true });
  let threw = false;
  const bad = setup({ pitDay1: undefined });
  try { readConfig(bad); } catch { threw = true; }
  check("6c missing pit day 1 fails closed", threw);
  threw = false;
  const bad2 = setup({ ladderSeedMd5: "0".repeat(32) });
  try { await rp({ dir: bad2, client, base: BASE, baseText: BASE, koreAccount, accountFrom, steps: 1, ...quiet }); } catch { threw = true; }
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
  await rp({ dir: a, client: ca, base: BASE, baseText: BASE, koreAccount, accountFrom, now: after, sleep: async () => {}, steps: 1, ...quiet });
  const pa = stateOf(a, "/pit-test");
  const sa = JSON.parse(readFileSync(`${a}/pit-test/pit-sends.json`, "utf8"));
  check("7a test config with pitDay1 10-29: Tuesday closes no day and logs no Tuesday sends", Object.keys(pa.closed).length === 0 && !pa.alloc[TUE] && !(sa.byDay ?? {})[TUE] && ca.published.length === 0);
  rmSync(a, { recursive: true });
  const b = setup({ test: true, pitDay1: TUE });
  const cb = mockClient({ staples: tue() });
  await rp({ dir: b, client: cb, base: BASE, baseText: BASE, koreAccount, accountFrom, now: after, sleep: async () => {}, steps: 1, ...quiet });
  const pb = stateOf(b, "/pit-test");
  check("7b test config with pitDay1 10-27: Tuesday closes at 00:10Z, exactly 1 KTA counts, burns logged, nothing published", !!pb.closed[TUE] && pb.alloc[TUE].miners[W1] === K(1) && pb.alloc[TUE].miners[ADDR.testB] === K(1) && pb.burns.filter((x) => x.from === ADDR.testB).length === 2 && cb.published.length === 0 && !existsSync(`${b}/pit-state.json`) && !existsSync(`${b}/www/lookup.json`));
  // Go-live afterwards: replace pit-config.json with the live file. Live state starts fresh in dir; pit-test/ is left alone.
  writeFileSync(`${b}/pit-config.json`, JSON.stringify({ pitDay1: "2026-10-29", ladderSeed: SNAP, ladderSeedMd5: SNAP_MD5, publicDir: `${b}/www` }));
  init(b, "2026-10-29", "live");
  const before = readFileSync(`${b}/pit-test/pit-state.json`, "utf8");
  await rp({ dir: b, client: cb, base: BASE, baseText: BASE, koreAccount, accountFrom, now: () => Date.parse("2026-10-28T12:00:00Z"), sleep: async () => {}, steps: 1, ...quiet });
  const pl = stateOf(b);
  check("7c switch to live config: fresh live state, no Tuesday carry-over, test state untouched", Object.keys(pl.closed).length === 0 && !pl.alloc[TUE] && Object.keys(pl.pending).length === 0 && readFileSync(`${b}/pit-test/pit-state.json`, "utf8") === before && cb.published.length === 0);
  rmSync(b, { recursive: true });
}

const base = { base: BASE, baseText: BASE, koreAccount, accountFrom, ...quiet };
const open = (p) => Object.values(p.intents).filter((i) => i.status === "intent");
const bytes = (dir, sub = "") => readFileSync(`${dir}${sub}/pit-state.json`, "utf8");

// ---- 8. Sage M1: a throw part-way through a close leaves the saved state exactly as it was ----
{
  // 8a/8b: pit.mjs allocate is atomic.
  const cfg = makeConfig({ pitDay1: DAY1 });
  const sends = [];
  for (const s of day1()) for (const b of s.blocks) b.operations.forEach((o, i) => sends.push({ tx: b.hash, block: b.hash, op: i, from: b.account, to: o.to, token: o.token === BASE ? "KTA" : o.token === ADDR.kore ? "KORE" : o.token, amount: o.amount, time: new Date(s.t).toISOString(), timeMs: s.t }));
  const pa = freshPit({ ...readConfig(setup()), ladderLast: "2026-10-25" }); // Sage's trigger: the snapshot day as ladderLast
  const beforeA = pitToJson(pa);
  let threwA = false; try { allocate(cfg, pa, DAY1, sends, {}); } catch (e) { threwA = /ladder gap/.test(e.message); }
  check("8a M1 allocate with a wrong ladder last day throws 'ladder gap' and leaves pit byte-identical", threwA && pitToJson(pa) === beforeA);
  const pb = freshPit(readConfig(setup()));
  const beforeB = pitToJson(pb);
  const bomb = new Proxy({ ...sends[0], block: "BOMB" }, { get(t, k) { if (k === "from") throw new Error("bad send row"); return t[k]; } });
  let threwB = false; try { allocate(cfg, pb, DAY1, [...sends, bomb], {}); } catch (e) { threwB = /bad send row/.test(e.message); }
  check("8b M1 allocate throwing after 6 sends were classified leaves pit byte-identical (no seen, pending, pot, burns)", threwB && pitToJson(pb) === beforeB);
  // 8c: runner. Pass 1 syncs; pass 2 throws inside closeOne after allocate; pass 3 closes normally.
  const dir = setup({ test: true });
  const ref = setup({ test: true });
  const c = mockClient({ staples: day1() }); const cr = mockClient({ staples: day1() });
  await rp({ dir, client: c, ...base, now: () => Date.parse(`${DAY1}T23:00:00Z`), sleep: async () => {}, steps: 1 });
  const saved = bytes(dir, "/pit-test");
  c.failBalance = 1; // closeOne reads the KTA balance after allocate in test mode: throw there
  await rp({ dir, client: c, ...base, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 });
  check("8c M1 runner: a throw inside the close leaves pit-state.json byte-identical", bytes(dir, "/pit-test") === saved);
  await rp({ dir, client: c, ...base, now: () => Date.parse("2026-11-03T00:12:00Z"), sleep: async () => {}, steps: 1 });
  await rp({ dir: ref, client: cr, ...base, now: () => Date.parse("2026-11-03T00:12:00Z"), sleep: async () => {}, steps: 1 });
  const p = stateOf(dir, "/pit-test"); const q = stateOf(ref, "/pit-test");
  const money = (x) => JSON.stringify({ b: x.budget_total, a: x.alloc_total, k: x.kept_total, u: x.cutover_unissued, pend: x.pending, paid: x.paid, lad: x.ladder, burns: x.burns.length, miners: x.alloc[DAY1].miners }, (k, v) => (typeof v === "bigint" ? String(v) : v));
    check("8d M1 after the retry: one pot (no 61,368), no phantom kept, W1 gets its streak day; equal to a run with no throw", p.budget_total === BigInt(budgetOf(DAY1)) * 10n ** 12n && p.kept_total === 0n && p.ladder[W1]?.streak === 1 && money(p) === money(q), `budget ${p.budget_total} kept ${p.kept_total}`);
  rmSync(dir, { recursive: true }); rmSync(ref, { recursive: true });
  // 8e: config validation (ladderLast, unknown keys, closeGraceMs) refuses before anything is written.
  const bad = [{ ladderLast: "2026-10-25" }, { ladderLast: "2026-11-01x" }, { surprise: 1 }, { closeGraceMs: "600000" }, { test: "yes" }, { pitDay1: "2026-02-30" }];
  const res = [];
  for (const extra of bad) {
    const d = setup(extra); let threw = false;
    try { await rp({ dir: d, client: mockClient({ staples: day1() }), ...base, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 }); } catch { threw = true; }
    res.push(threw && !existsSync(`${d}/pit-state.json`) && !existsSync(`${d}/pit-test/pit-state.json`));
    rmSync(d, { recursive: true });
  }
  check("8e M1 bad ladderLast / unknown key / bad grace / bad test flag / bad day: refused, no state written", res.every(Boolean), res.join(","));
  // 8f: a state whose ladder last day disagrees with the closes, or made for another config, is refused and left alone.
  const d = setup({ test: true });
  const cd = mockClient({ staples: day1() });
  await rp({ dir: d, client: cd, ...base, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 });
  const good = bytes(d, "/pit-test");
  writeFileSync(`${d}/pit-test/pit-state.json`, good.replace(`"lmeta":{"last":"${DAY1}"}`, `"lmeta":{"last":"2026-10-25"}`));
  const corrupt = bytes(d, "/pit-test");
  let threwF = false; try { await rp({ dir: d, client: cd, ...base, now: () => Date.parse("2026-11-03T01:00:00Z"), sleep: async () => {}, steps: 1 }); } catch (e) { threwF = /ladder last day/.test(e.message); }
  check("8f M1 a state with a ladder last day that disagrees with the closes is refused, file untouched, HALT in pit-test", corrupt !== good && threwF && bytes(d, "/pit-test") === corrupt && existsSync(`${d}/pit-test/HALT`) && !existsSync(`${d}/HALT`));
  unlinkSync(`${d}/pit-test/HALT`);
  writeFileSync(`${d}/pit-test/pit-state.json`, good);
  writeFileSync(`${d}/pit-config.json`, JSON.stringify({ pitDay1: "2026-11-01", ladderSeed: SNAP, ladderSeedMd5: SNAP_MD5, publicDir: `${d}/www`, test: true }));
  let threwG = false; try { await rp({ dir: d, client: cd, ...base, now: () => Date.parse("2026-11-03T01:00:00Z"), sleep: async () => {}, steps: 1 }); } catch (e) { threwG = /was made for/.test(e.message); }
  check("8g M1 a state made for another pitDay1 is refused", threwG && bytes(d, "/pit-test") === good);
  rmSync(d, { recursive: true });
}

// ---- 9. Ops R-B1: never void or resend without searching the shaft history for the intent key ----
{
  // 9h: the key is on chain but the send does not match the intent (amount): PAYOUT_KEY_MISMATCH, PAYHOLD, not marked paid.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "after" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  c.published[0].amount -= 1n;
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  const p = stateOf(dir);
  check("9h R-B1 key on chain with the wrong amount: PAYOUT_KEY_MISMATCH, PAYHOLD, intent left open, no second send", open(p).length === 1 && c.published.length === 1 && existsSync(`${dir}/PAYHOLD`) && p.alerts.some((x) => x[1] === "PAYOUT_KEY_MISMATCH"));
  rmSync(dir, { recursive: true });
}
{
  // 9a: Ops E4. The send lands, the runner crashes before settle, then the same KORE amount flows into the vault.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "after" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const mid = stateOf(dir); const [it] = open(mid); const key = Object.keys(mid.intents).find((k) => mid.intents[k] === it) ?? Object.entries(mid.intents).find(([, v]) => v.status === "intent")[0];
  c.kore += it.amt; // top-up / refund / mistaken send of the same size into the shaft
  const proxy = judgeIntent(c.kore, { floor: it.floor, amount: it.amt });
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  const end = stateOf(dir);
  const sameKey = c.published.filter((x) => x.key === key).length;
  check("9a R-B1 E4: balance alone says 'missed', history finds the key: marked paid, no second send", proxy === "missed" && sameKey === 1 && end.intents[key].status === "sent" && c.published.length === 3 && new Set(c.published.map((x) => x.key)).size === 3 && !!end.closed[DAY1], `proxy ${proxy}, sends with key ${sameKey}`);
  rmSync(dir, { recursive: true });
}
{
  // 9b: FeeStop no longer voids on the spot; it waits out the 6 min and the history search.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1() });
  c.feeBad = true;
  let t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const a = stateOf(dir);
  check("9b R-B1 a FeeStop leaves the intent open (fee reserved), nothing voided on the spot", open(a).length === 1 && c.published.length === 0 && a.fee_spent[DAY1] === FEE_RAW);
  t += 8 * 60_000;
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const b = stateOf(dir);
  check("9c R-B1 after 6 min, key not in history, balance 'missed': voided once, then each wallet paid once", b.alerts.filter((x) => x[1] === "PAYOUT_VOID").length === 1 && c.published.length === 3 && new Set(c.published.map((x) => x.key)).size === 3 && !!b.closed[DAY1]);
  rmSync(dir, { recursive: true });
}
{
  // 9d: history can't be read to the intent time: hold, never void.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "before" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  c.intakeStuck = true;
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  const p = stateOf(dir);
  check("9d R-B1 incomplete shaft history: no void, PAYHOLD, PAYOUT_WAIT_HISTORY", open(p).length === 1 && c.published.length === 0 && existsSync(`${dir}/PAYHOLD`) && p.alerts.some((x) => x[1] === "PAYOUT_WAIT_HISTORY"));
  rmSync(dir, { recursive: true });
}
{
  // 9e: an unrelated outflow of the same size makes the balance say 'paid'; with no key on chain it is not marked paid.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "before" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const [it] = open(stateOf(dir));
  c.kore -= it.amt;
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  const p = stateOf(dir);
  check("9e R-B1 balance says 'paid' but the key is not on chain: not marked paid, PAYHOLD, PAYOUT_UNPROVEN", open(p).length === 1 && Object.keys(p.paid).length === 0 && existsSync(`${dir}/PAYHOLD`) && p.alerts.some((x) => x[1] === "PAYOUT_UNPROVEN"));
  rmSync(dir, { recursive: true });
}
{
  // 9f/9g (Ops nb2): a pending block with an old date is expired and does not block the void; a dateless one holds after 30 min.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "before" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  c.pending = { date: new Date(t) };
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  const p = stateOf(dir);
  check("9f expired pending block: alert PENDING_EXPIRED, intent voided and paid once", p.alerts.some((x) => x[1] === "PENDING_EXPIRED") && c.published.length === 3 && new Set(c.published.map((x) => x.key)).size === 3);
  rmSync(dir, { recursive: true });
  const d2 = setup();
  writeFileSync(`${d2}/SEND`, "on\n");
  const c2 = mockClient({ staples: day1(), crash: "before" });
  c2.pending = null;
  await rp({ dir: d2, client: c2, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  c2.pending = { operations: [] };
  const ck = clock("2026-11-03T00:12:00Z");
  await rp({ dir: d2, client: c2, ...base, now: ck.now, sleep: ck.sleep, steps: 70 });
  const p2 = stateOf(d2);
  check("9g dateless pending block for 30 min: PENDING_STUCK alert and PAYHOLD, nothing voided or sent", p2.alerts.some((x) => x[1] === "PENDING_STUCK") && existsSync(`${d2}/PAYHOLD`) && open(p2).length === 1 && c2.published.length === 0);
  rmSync(d2, { recursive: true });
}

// ---- 10. Ops R-B2: 60 sends and 3.0 KTA per rolling hour, a 60 s gap, 0.5 KTA per wall-clock UTC day ----
const many = (day, n, hour = 1) => Array.from({ length: n }, (_, i) => staple(`${day}T${String(hour).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:${String(Math.floor(i / 60)).padStart(2, "0")}.000Z`, [{ from: W(i + 10), ops: [{ token: BASE, amount: K(1) }] }]));
function paceStats(pub) {
  const ts = pub.map((x) => x.t).sort((a, b) => a - b);
  let maxHour = 0; let maxHourFee = 0n; let minGap = Infinity;
  for (let i = 0; i < ts.length; i += 1) {
    if (i) minGap = Math.min(minGap, ts[i] - ts[i - 1]);
    const inHour = pub.filter((x) => x.t >= ts[i] && x.t < ts[i] + 3_600_000);
    maxHour = Math.max(maxHour, inHour.length);
    const f = inHour.reduce((a, x) => a + x.fee, 0n); if (f > maxHourFee) maxHourFee = f;
  }
  const byDay = {};
  for (const x of pub) { const d = new Date(x.t).toISOString().slice(0, 10); byDay[d] = (byDay[d] ?? 0n) + x.fee; }
  return { n: ts.length, maxHour, maxHourFee, minGap, spanMs: ts.length ? ts.at(-1) - ts[0] : 0, byDay };
}
const kta = (raw) => (Number(raw) / 1e18).toFixed(5);
{
  // 10a: Ops E2. 130 miners in one day; the old runner published 123 in 0 s.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: many(DAY1, 130), kore: 100_000_000n });
  const ck = clock("2026-11-03T00:11:00Z");
  c.now = ck.now;
  await runPit({ dir, client: c, ...base, now: ck.now, sleep: ck.sleep, steps: 300 });
  const st = paceStats(c.published);
  const p = stateOf(dir);
  check("10a R-B2 E2: 123 payouts spread out: <=60 per rolling hour, gap >= 60 s, span >= 2 h, <=3.0 KTA per hour, <=0.5 KTA that UTC day",
    st.n === 123 && st.maxHour <= 60 && st.minGap >= 60_000 && st.spanMs >= 2 * 3_600_000 && st.maxHourFee <= 3n * ONE_KTA && Object.values(st.byDay).every((f) => f <= DAY_CAP) && !!p.closed[DAY1],
    `n ${st.n} maxHour ${st.maxHour} minGap ${st.minGap / 1000}s span ${(st.spanMs / 3.6e6).toFixed(2)}h day fees ${Object.entries(st.byDay).map(([d, f]) => `${d}:${kta(f)}`).join(" ")}`);
  check("10b the close row is written after the paced queue, status day_cap (130 due, 123 fit the day)", p.closed[DAY1].close_status === "day_cap" && p.closed[DAY1].payouts_queued === 130, `${p.closed[DAY1].close_status} queued ${p.closed[DAY1].payouts_queued}`);
  rmSync(dir, { recursive: true });
}
{
  // 10c: Ops E3. 5 days down, then one restart at day 6 00:11Z. The old runner spent 2.4846 KTA in one pass.
  const days = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"];
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: days.flatMap((d) => many(d, 123)), kore: 500_000_000n, kta: 20n * ONE_KTA });
  const ck = clock("2026-11-07T00:11:00Z");
  c.now = ck.now;
  await runPit({ dir, client: c, ...base, now: ck.now, sleep: ck.sleep, steps: 600 }); // 5 h
  const p1 = stateOf(dir);
  const st1 = paceStats(c.published);
  check("10c R-B2 E3: all 5 backlog days closed in order within 5 h, but only <=0.5 KTA of fees on 11-07",
    days.every((d) => !!p1.closed[d]) && p1.last_pit_closed === "2026-11-06" && (st1.byDay["2026-11-07"] ?? 0n) <= DAY_CAP && st1.maxHour <= 60 && st1.maxHourFee <= 3n * ONE_KTA,
    `paid ${st1.n}, 11-07 fees ${kta(st1.byDay["2026-11-07"] ?? 0n)}, statuses ${days.map((d) => p1.closed[d]?.close_status).join("/")}`);
  check("10d later backlog days close with status wall_day_cap (KORE stays due, nothing lost)", days.slice(1).every((d) => p1.closed[d].close_status === "wall_day_cap") && p1.alerts.filter((a) => a[1] === "FEE_WALL_DAY_CAP").length === 1);
  ck.set("2026-11-08T00:11:00Z");
  await runPit({ dir, client: c, ...base, now: ck.now, sleep: ck.sleep, steps: 400 });
  ck.set("2026-11-09T00:11:00Z");
  await runPit({ dir, client: c, ...base, now: ck.now, sleep: ck.sleep, steps: 400 });
  const st = paceStats(c.published);
  const p = stateOf(dir);
  const keysOk = new Set(c.published.map((x) => x.key)).size === c.published.length;
  check("10e three wall-clock days later: every UTC day <=0.5 KTA, every rolling hour <=60 sends and <=3.0 KTA, no key twice",
    Object.values(st.byDay).every((f) => f <= DAY_CAP) && st.maxHour <= 60 && st.maxHourFee <= 3n * ONE_KTA && st.minGap >= 60_000 && keysOk,
    `paid ${st.n}, fees ${Object.entries(st.byDay).map(([d, f]) => `${d}:${kta(f)}`).join(" ")}, maxHour ${st.maxHour}`);
  // Ops G23: an intent's since is the oldest open lot day. The first payouts are all for 11-02 KORE.
  const first = c.published.slice(0, 50).map((x) => p.intents[x.key]);
  check("10f G23: payout intents record the oldest open lot day (11-02) as since", first.every((i) => i.since === "2026-11-02"));
  rmSync(dir, { recursive: true });
}
{
  // 10g: Ops nb1. The real fee cap passed to the fee block never dips into the 2 KTA reserve.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), kta: 2n * ONE_KTA + 5_000_000_000_000_000n, fee: 4_000_000_000_000_000n });
  // Quote 0.004 passes the reserve check (0.005 spare), but the vote then asks 0.006: the cap must refuse it.
  const real = c.publishBuilder;
  c.publishBuilder = async (b, o) => { c.fee = 6_000_000_000_000_000n; try { return await real(b, o); } finally { c.fee = 4_000_000_000_000_000n; } };
  await rp({ dir, client: c, ...base, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 });
  check("10g nb1 the fee block cap includes the reserve: a 0.006 vote with 0.005 spare is refused, reserve intact", c.published.length === 0 && c.kta === 2n * ONE_KTA + 5_000_000_000_000_000n);
  rmSync(dir, { recursive: true });
}

{
  // 10h: the rolling-hour count guard on its own (gap off): never more than 60 sends in any hour.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: many(DAY1, 130), kore: 100_000_000n });
  const ck = clock("2026-11-03T00:11:00Z"); c.now = ck.now;
  await runPit({ dir, client: c, ...base, now: ck.now, sleep: ck.sleep, steps: 400, pace: { gapMs: 0 } });
  const st = paceStats(c.published);
  check("10h R-B2 with no gap, the hour count alone holds: <=60 sends in any rolling hour, 123 sent over > 1 h", st.n === 123 && st.maxHour <= 60 && st.spanMs >= 3_600_000, `n ${st.n} maxHour ${st.maxHour}`);
  rmSync(dir, { recursive: true });
}
{
  // 10i: the 3.0 KTA per hour fee guard on its own (gap off, hour count and wall-day cap lifted; with real pace 60/h x 0.05 cap already implies <=3.0): a 10-day backlog at 0.04 KTA a send.
  const days = Array.from({ length: 10 }, (_, i) => new Date(Date.parse(`${DAY1}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: days.flatMap((d) => many(d, 12)), kore: 500_000_000n, kta: 50n * ONE_KTA, fee: 40_000_000_000_000_000n });
  const ck = clock("2026-11-12T00:11:00Z"); c.now = ck.now;
  await runPit({ dir, client: c, ...base, now: ck.now, sleep: ck.sleep, steps: 200, pace: { gapMs: 0, perHour: 10_000, wallDayFee: 100n * ONE_KTA } });
  const st = paceStats(c.published);
  check("10i R-B2 hour fee guard alone: <=3.0 KTA of fees in any rolling hour", st.maxHourFee <= 3n * ONE_KTA && st.maxHour === 75 && st.n === 120, `n ${st.n} maxHour ${st.maxHour} max hour fees ${kta(st.maxHourFee)}`);
  rmSync(dir, { recursive: true });
}

// ---- 11. Ops R-B3: a lost pit-state.json never re-seeds and re-pays ----
{
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1() });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  check("11a first start consumed pit-init (moved to pit-init.used)", !existsSync(`${dir}/pit-init`) && existsSync(`${dir}/pit-init.used`) && c.published.length === 3);
  unlinkSync(`${dir}/pit-state.json`);
  let threw = false; try { await rp({ dir, client: c, ...base, now: () => t + 3_600_000, sleep: async () => {}, steps: 1 }); } catch (e) { threw = /refusing to seed/.test(e.message); }
  check("11b Ops E1: state deleted -> refuses, HALT written, no state seeded, no send again", threw && existsSync(`${dir}/HALT`) && !existsSync(`${dir}/pit-state.json`) && c.published.length === 3);
  // 11c: every pit file gone too, and a new pit-init: the shaft history still shows pit keys -> refuse.
  for (const n of readdirSync(dir)) if (n.startsWith("pit-") && n !== "pit-config.json" || n === "HALT") rmSync(`${dir}/${n}`, { force: true });
  init(dir, DAY1, "live");
  let threw2 = false; try { await rp({ dir, client: c, ...base, now: () => t + 7_200_000, sleep: async () => {}, steps: 1 }); } catch (e) { threw2 = /keyed KORE sends from the shaft/.test(e.message); }
  check("11c all pit files gone + new pit-init: shaft history has pit keys since pitDay1 -> refuses, no re-pay", threw2 && !existsSync(`${dir}/pit-state.json`) && c.published.length === 3);
  rmSync(dir, { recursive: true });
  const d2 = setup();
  unlinkSync(`${d2}/pit-init`);
  let threw3 = false; try { await rp({ dir: d2, client: mockClient({ staples: day1() }), ...base, now: () => t, sleep: async () => {}, steps: 1 }); } catch (e) { threw3 = /needs the one-time pit-init/.test(e.message); }
  check("11d no state and no pit-init: refuses, nothing written", threw3 && !existsSync(`${d2}/pit-state.json`));
  rmSync(d2, { recursive: true });
  const d3 = setup();
  init(d3, DAY1, "test");
  let threw4 = false; try { await rp({ dir: d3, client: mockClient({ staples: day1() }), ...base, now: () => t, sleep: async () => {}, steps: 1 }); } catch (e) { threw4 = /pit-init is for/.test(e.message); }
  check("11e a test pit-init does not start a live pit", threw4 && !existsSync(`${d3}/pit-state.json`));
  rmSync(d3, { recursive: true });
  // 11f: test mode too: state lost next to pit-test outputs -> refuse; HALT goes to pit-test only (Sage S5).
  const d4 = setup({ test: true });
  const c4 = mockClient({ staples: day1() });
  await rp({ dir: d4, client: c4, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  unlinkSync(`${d4}/pit-test/pit-state.json`);
  let threw5 = false; try { await rp({ dir: d4, client: c4, ...base, now: () => t + 60_000, sleep: async () => {}, steps: 1 }); } catch { threw5 = true; }
  check("11f S5 test mode: lost state refused, HALT in pit-test/ only, the live folder has no HALT or PAYHOLD", threw5 && existsSync(`${d4}/pit-test/HALT`) && !existsSync(`${d4}/HALT`) && !existsSync(`${d4}/PAYHOLD`));
  rmSync(d4, { recursive: true });
  // 11g: no state, live pit-init, but the shaft history cannot be read back to pit day 1: refuse to seed.
  const d5 = setup();
  const c5 = mockClient({ staples: day1() }); c5.intakeStuck = true;
  let threw6 = false; try { await rp({ dir: d5, client: c5, ...base, now: () => t, sleep: async () => {}, steps: 1 }); } catch (e) { threw6 = /history since pit day 1 is incomplete/.test(e.message); }
  check("11g R-B3 first live start with incomplete shaft history: refuses, nothing seeded or sent", threw6 && !existsSync(`${d5}/pit-state.json`) && c5.published.length === 0 && existsSync(`${d5}/HALT`));
  rmSync(d5, { recursive: true });
  // 11h: a state made for another run (startTime moved in test mode) is refused, file untouched.
  const d6 = setup({ test: true, startTime: `${DAY1}T00:00:00Z` });
  const c6 = mockClient({ staples: day1() });
  await rp({ dir: d6, client: c6, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const before6 = readFileSync(`${d6}/pit-test/pit-state.json`, "utf8");
  writeFileSync(`${d6}/pit-config.json`, JSON.stringify({ test: true, pitDay1: DAY1, startTime: `${DAY1}T06:00:00Z`, ladderSeed: SNAP, ladderSeedMd5: SNAP_MD5, publicDir: `${d6}/www` }));
  let threw7 = false; try { await rp({ dir: d6, client: c6, ...base, now: () => t + 60_000, sleep: async () => {}, steps: 1 }); } catch (e) { threw7 = /was made for/.test(e.message); }
  check("11h R-B3 a state made for another run (different start) is refused, state untouched", threw7 && readFileSync(`${d6}/pit-test/pit-state.json`, "utf8") === before6);
  rmSync(d6, { recursive: true });
}

// ---- 11s. Sage N-1: a fresh live start needs the shaft head agreed by every rep (re-upgrade after a rollback) ----
{
  const t = Date.parse("2026-11-03T00:11:00Z");
  for (const [name, mod] of [["one rep lags", (c) => { c.repHeads.rep2 = "PB-older"; }], ["one rep errors", (c) => { c.repHeads.rep3 = "error"; }], ["no reps known", (c) => { c.noReps = true; }]]) {
    const dir = setup();
    writeFileSync(`${dir}/SEND`, "on\n");
    const c = mockClient({ staples: day1() }); mod(c);
    let msg = ""; try { await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 }); } catch (e) { msg = e.message; }
    check(`11s Sage N-1 fresh live start, ${name}: refuses (head not agreed), HALT, no state, pit-init kept, no send`, /shaft head not agreed/.test(msg) && existsSync(`${dir}/HALT`) && !existsSync(`${dir}/pit-state.json`) && existsSync(`${dir}/pit-init`) && c.published.length === 0, msg);
    rmSync(dir, { recursive: true });
  }
  const dir = setup();
  const c = mockClient({ staples: day1() });
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  check("11t Sage N-1 all reps agree: the fresh live start seeds as before", existsSync(`${dir}/pit-state.json`) && existsSync(`${dir}/pit-init.used`) && !existsSync(`${dir}/HALT`));
  rmSync(dir, { recursive: true });
}

// ---- 11u/11v. Ops review3 F1 repro (rc-init) and F2: whole live dir lost, a fresh live pit-init, and a history that lags
// (the newest shaft rows left out, the rest consistent, so the walk is complete). With 4 honest reps the head check refuses
// (before: 3 -> 6 sends, no HALT). With one known rep that lags along with the history, F2 refuses (fewer than 2 reps).
for (const [name, mod, why] of [["4 honest reps", () => {}, /shaft head not agreed \(head GB-shaft vs reps/], ["one rep that lags too (F2)", (c) => { c.oneRep = true; c.repHeads.rep1 = "GB-shaft"; }, /fewer than 2 representatives/]]) {
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1() });
  await rp({ dir, client: c, ...base, now: () => Date.parse("2026-11-03T05:00:00Z"), sleep: async () => {}, steps: 2 });
  const paid = c.published.length;
  for (const f of readdirSync(dir)) if (!["pit-config.json", "SEND"].includes(f)) rmSync(`${dir}/${f}`, { recursive: true });
  init(dir, DAY1, "live");
  c.historyLag = paid; mod(c);
  let msg = ""; try { await rp({ dir, client: c, ...base, now: () => Date.parse("2026-11-03T05:30:00Z"), sleep: async () => {}, steps: 2 }); } catch (e) { msg = e.message; }
  check(`11${name.startsWith("4") ? "u" : "v"} Ops F1/F2 lost dir + fresh live init + lagging history, ${name}: refuses with HALT, still ${paid} sends, nothing seeded`, paid === 3 && why.test(msg) && existsSync(`${dir}/HALT`) && c.published.length === paid && !existsSync(`${dir}/pit-state.json`), `${msg} sends ${c.published.length}`);
  rmSync(dir, { recursive: true });
}

// ---- 12. Sage S1, S4 and Ops nb5, nb7 ----
{
  const dir = setup();
  const late = [staple(`${DAY1}T22:00:00.000Z`, [{ from: W2, ops: [{ token: ADDR.kore, amount: 7n }, { token: BASE, amount: K(2) }, { token: ADDR.usdc, amount: 5n }] }])];
  const c = mockClient({ staples: day1() });
  await rp({ dir, client: c, ...base, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 });
  c.staples.push(...late);
  await rp({ dir, client: c, ...base, now: () => Date.parse("2026-11-03T00:20:00Z"), sleep: async () => {}, steps: 1 });
  const csvText = readFileSync(`${dir}/pit-burns.csv`, "utf8");
  const head = csvText.split("\n")[0].split(",");
  const rows = csvText.trim().split("\n").slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [head[i], v])));
  const store = JSON.parse(readFileSync(`${dir}/pit-sends.json`, "utf8"));
  check("12a S1 late KORE and USDC burns are in pit-burns.csv with late=1; on-time rows have late empty", rows.filter((r) => r.late === "1").length === 2 && rows.filter((r) => r.late === "1" && r.token === "KORE" && r.amount_raw === "7").length === 1 && rows.filter((r) => r.late === "").length === 3);
  check("12b S1 the late KTA send is kept in pit-sends.json lateSends with its amount, not counted", store.lateSends?.length === 1 && store.lateSends[0].amount_raw === `${K(2)}n` && stateOf(dir).alloc[DAY1].miners[W2] === K(1));
  rmSync(dir, { recursive: true });
  const r = [];
  for (const [bt, ka] of [["", koreAccount], [BASE, ""], [BASE, ADDR.usdc]]) {
    const d = setup(); let threw = false;
    try { await rp({ dir: d, client: mockClient({ staples: day1() }), ...base, baseText: bt, koreAccount: ka, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 }); } catch (e) { threw = /refusing to start/.test(e.message); }
    r.push(threw && !existsSync(`${d}/pit-state.json`)); rmSync(d, { recursive: true });
  }
  check("12c S4 empty KTA id, empty KORE id, or a KORE id that is not KORE: refused before any state", r.every(Boolean), r.join(","));
  const d = setup();
  writeFileSync(`${d}/payout-intent.json`, "{}");
  let threw = false; try { await rp({ dir: d, client: mockClient({ staples: day1() }), ...base, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 }); } catch (e) { threw = /legacy payout-intent/.test(e.message); }
  check("12d nb5 an open legacy payout-intent.json refuses the switch", threw && !existsSync(`${d}/pit-state.json`));
  rmSync(d, { recursive: true });
  const odd = pitFromJson(JSON.stringify({ a: "007n", b: "-0n", c: "12n", d: "0n" }));
  check("12e nb7 strict BigInt load: only what pitToJson writes becomes a BigInt", odd.a === "007n" && odd.b === "-0n" && odd.c === 12n && odd.d === 0n);
}
{
  // 12f nb4/R-B3: every state write keeps the previous file as .bak.
  const dir = setup({ test: true });
  const c = mockClient({ staples: day1() });
  await rp({ dir, client: c, ...base, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 });
  check("12f pit-state.json.bak kept beside the state", existsSync(`${dir}/pit-test/pit-state.json.bak`) && !existsSync(`${dir}/pit-test/pit-state.json.tmp`));
  rmSync(dir, { recursive: true });
}

{
  // 12g Sage M3 (runner side): a wallet whose best rung is Shift Boss but whose streak fell to 3 is told the rung above best.
  const dir = setup();
  const cfg = readConfig(dir);
  const pit = freshPit({ ...cfg });
  const any = Object.values(pit.ladder)[0];
  pit.ladder[W1] = { ...structuredClone(any), streak: 3, best: 1 };
  const v = publicViews(cfg, pit, { today: DAY1, todaySends: [], testMode: false, updated: "x" });
  const row = v.ladder.wallets.find((r) => r.ladderStreak === 3 && r.rank === "Shift Boss Shield");
  check("12g M3 runner: best Shift Boss, streak 3 -> next rung Narrator Book at 56 (not Practice Shield at 14)", !!row && row.nextRank === "Narrator Book" && row.nextAt === 56, JSON.stringify(row && { rank: row.rank, nextRank: row.nextRank, nextAt: row.nextAt }));
  rmSync(dir, { recursive: true });
}

// ---- 13. Ops re-check B-1 (LIVE blocker): history completeness, clock skew, unkeyed sends; N-2, N-3 and the 6 guard gaps ----
// r1: Ops' 2-send repro. The send lands, the runner crashes before settle, then exactly it.amt flows back into the shaft, so
// the balance alone says "missed". `twist` then changes what the node returns for the shaft history.
async function r1(twist) {
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "after" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const first = c.published[0];
  const mid = stateOf(dir); const key = Object.entries(mid.intents).find(([, v]) => v.status === "intent")[0];
  c.kore += first.amount;
  const orig = c._history;
  const intake = (f) => { c._history = async (a, o) => (a === ADDR.intake ? f(await orig(a, o), o) : orig(a, o)); };
  const ext = (f) => intake((rows) => { for (const r of rows) for (const b of r.voteStaple.blocks) for (const op of b.operations) op.external = f(op.external); return rows; });
  if (twist === "empty") intake(() => []);
  // short: a lagging node returns one newer unrelated row and stops; neither the payout nor anything older is in it.
  if (twist === "short") { c.published.push({ to: W(9), amount: 1n, key: `kore-${W(9)}-1`, t: t + 1000, fee: 0n }); intake((rows) => rows.filter((r) => r.voteStaple.blocks.some((b) => b.operations.some((op) => op.to === W(9))))); }
  if (twist === "skew2") first.t = t - 2 * 60_000;
  if (twist === "skew14") first.t = t - 14 * 60_000;
  if (twist === "b64") ext((e) => Buffer.from(String(e)).toString("base64"));
  if (twist === "hex") ext((e) => Buffer.from(String(e)).toString("hex"));
  if (twist === "none") ext(() => undefined);
  // Ops R-1: the node leaves out the paid row but still returns older rows. dropmid: a newer shaft send sits above the gap,
  // so only the hash chain shows it. headlag: the paid row is the shaft head, so the walk looks whole and only the reps'
  // head (which every rep reports as the paid block) shows it.
  const paid = (r) => r.voteStaple.blocks.some((b) => b.operations.some((op) => op.external === first.key));
  if (twist === "dropmid") { c.published.push({ to: W(9), amount: 1n, key: `kore-${W(9)}-1`, t: t + 1000, fee: 0n }); intake((rows) => rows.filter((r) => !paid(r))); }
  if (twist === "headlag") intake((rows) => rows.filter((r) => !paid(r)));
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  await rp({ dir, client: c, ...base, now: () => t + 10 * 60_000, sleep: async () => {}, steps: 1 });
  const p = stateOf(dir);
  const r = { n: c.published.filter((x) => x.to === first.to).length, status: p.intents[key].status, hold: existsSync(`${dir}/PAYHOLD`), alerts: p.alerts.map((a) => a[1]), texts: p.alerts.map((a) => String(a[2])) };
  rmSync(dir, { recursive: true });
  return r;
}
{
  const e = await r1("empty");
  check("13a B-1 Ops repro, shaft history page empty: no second send, not voided, PAYHOLD + PAYOUT_WAIT_HISTORY", e.n === 1 && e.status === "intent" && e.hold && e.alerts.includes("PAYOUT_WAIT_HISTORY") && !e.alerts.includes("PAYOUT_VOID") && e.texts.some((x) => /shaft history incomplete/.test(x)), JSON.stringify(e));
  const s = await r1("short");
  check("13b B-1 shaft history short page that never reaches the intent time: no second send, PAYHOLD + PAYOUT_WAIT_HISTORY", s.n === 1 && s.status === "intent" && s.hold && s.alerts.includes("PAYOUT_WAIT_HISTORY"), JSON.stringify(s));
  const k2 = await r1("skew2");
  check("13c B-1 box clock 2 min fast (staple stamped 2 min before it.at): key found, marked paid, no second send", k2.n === 1 && k2.status === "sent" && !k2.hold, JSON.stringify(k2));
  const k14 = await r1("skew14");
  check("13d B-1 staple 14 min before it.at: still inside the 15 min window, paid once", k14.n === 1 && k14.status === "sent" && !k14.hold, JSON.stringify(k14));
  for (const tw of ["dropmid", "headlag"]) {
    const r = await r1(tw);
    check(`13r Ops R-1 node drops the paid row but returns older ones (${tw}): no second send, not voided, PAYHOLD + PAYOUT_WAIT_HISTORY`, r.n === 1 && r.status === "intent" && r.hold && r.alerts.includes("PAYOUT_WAIT_HISTORY") && !r.alerts.includes("PAYOUT_VOID"), JSON.stringify(r));
  }
  for (const tw of ["b64", "hex", "none"]) {
    const r = await r1(tw);
    check(`13e B-1/N-1 the send's external comes back as ${tw}: unkeyed send to the wallet for the amount -> PAYOUT_UNPROVEN, PAYHOLD, no second send`, r.n === 1 && r.status === "intent" && r.hold && r.alerts.includes("PAYOUT_UNPROVEN") && !r.alerts.includes("PAYOUT_VOID"), JSON.stringify(r));
  }
}
// Ops R-1 freshness gate: the send never went out (crash before publish), the history is whole and the key is absent, so
// the void is right, but only once every rep agrees on the shaft head the walk saw.
async function rv(mod) {
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "before" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const [it] = open(stateOf(dir));
  mod(c);
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  const p = stateOf(dir);
  const r = { sends: c.published.length, status: Object.values(p.intents).find((v) => v.w === it.w && v.at === it.at)?.status, hold: existsSync(`${dir}/PAYHOLD`), alerts: p.alerts.map((a) => a[1]) };
  rmSync(dir, { recursive: true });
  return r;
}
{
  const ok = await rv(() => {});
  check("13s R-1 all reps agree on the shaft head the walk saw: the void still happens (no hold)", ok.alerts.includes("PAYOUT_VOID") && !ok.hold && !ok.alerts.includes("PAYOUT_WAIT_HISTORY"), JSON.stringify(ok));
  for (const [name, mod] of [["one rep reports another head (lag)", (c) => { c.repHeads.rep2 = "PB-older"; }], ["one rep errors", (c) => { c.repHeads.rep3 = "error"; }], ["one rep reports no head", (c) => { c.repHeads.rep1 = null; c.client.getAccountHeadInfo = ((g) => async (a, rep) => (rep.endpoints.api === "rep1" ? null : g(a, rep)))(c.client.getAccountHeadInfo); }], ["no reps known", (c) => { c.noReps = true; }]]) {
    const r = await rv(mod);
    check(`13t R-1 ${name}: not voided, PAYHOLD + PAYOUT_WAIT_HISTORY, no send`, !r.alerts.includes("PAYOUT_VOID") && r.hold && r.alerts.includes("PAYOUT_WAIT_HISTORY") && r.sends === 0, JSON.stringify(r));
  }
}
{
  // 13f: an unkeyed shaft send to the same wallet for a DIFFERENT amount does not block the void (crash before publish).
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "before" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const [it] = open(stateOf(dir));
  c.published.push({ to: it.w, amount: it.amt + 1n, key: undefined, t: t + 1000, fee: 0n });
  c.published.push({ to: W(9), amount: it.amt, key: undefined, t: t + 2000, fee: 0n });
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  const p = stateOf(dir);
  check("13f B-1 unkeyed sends for another amount or another wallet do not hold: voided once, each wallet paid once", p.alerts.filter((x) => x[1] === "PAYOUT_VOID").length === 1 && !existsSync(`${dir}/PAYHOLD`) && c.published.filter((x) => x.key).length === 3 && !!p.closed[DAY1]);
  rmSync(dir, { recursive: true });
}
{
  // 13g N-2: a dateless pending block across a restart on every pass still reaches PENDING_STUCK + PAYHOLD after 30 min.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "before" });
  let t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  c.pending = { operations: [] };
  for (let i = 0; i < 20; i += 1) { t += 2 * 60_000; await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 }); }
  const p = stateOf(dir);
  check("13g N-2 stuck timer is kept in pit-state: restarts every 2 min, PENDING_STUCK + PAYHOLD after 30 min, nothing voided or sent", p.alerts.some((x) => x[1] === "PENDING_STUCK") && existsSync(`${dir}/PAYHOLD`) && open(p).length === 1 && c.published.length === 0 && typeof p.stuck_since === "number");
  rmSync(dir, { recursive: true });
}
{
  // 13g2 N-2: the stuck timer is on disk as soon as it starts, not only at the end of the pass (a kill right after cannot lose it).
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "before" });
  let t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  c.pending = { operations: [] };
  const inner = c.pendingBlock.bind(c);
  const disk = [];
  // the pass reads the pending block more than once; by the second read the timer the first read started must already be in the file
  c.pendingBlock = async () => { disk.push(stateOf(dir).stuck_since); return inner(); };
  t += 2 * 60_000;
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  check("13g2 N-2 stuck timer is saved to pit-state the moment it starts", disk.length >= 2 && disk[0] === null && disk[1] === t);
  rmSync(dir, { recursive: true });
}
{
  // 13h/13i N-3: legacyUntil may cover the legacy close payouts on pit day 1, but never reach the first pit close.
  const t = Date.parse("2026-11-03T00:11:00Z");
  const d1 = setup(); init(d1, DAY1, "live", { legacyUntil: "2026-11-03T00:00:00Z" });
  const c1 = mockClient({ staples: day1() });
  let threw = ""; try { await rp({ dir: d1, client: c1, ...base, now: () => t, sleep: async () => {}, steps: 1 }); } catch (e) { threw = e.message; }
  check("13h N-3 legacyUntil at the end of pit day 1 (could hide pit sends): refused, nothing seeded or sent", /legacyUntil .* could hide pit sends/.test(threw) && !existsSync(`${d1}/pit-state.json`) && c1.published.length === 0, threw);
  rmSync(d1, { recursive: true });
  const d2 = setup(); init(d2, DAY1, "live", { legacyUntil: `${DAY1}T02:00:00Z` }); writeFileSync(`${d2}/SEND`, "on\n");
  const c2 = mockClient({ staples: day1() });
  c2.published.push({ to: W(9), amount: 5n, key: `kore-${W(9)}-5`, t: Date.parse(`${DAY1}T01:00:00Z`), fee: 0n });
  await rp({ dir: d2, client: c2, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  check("13i N-3 legacyUntil 02:00Z on pit day 1 covers a legacy kore- send at 01:00Z: seeds and pays", existsSync(`${d2}/pit-state.json`) && c2.published.length === 4, `state ${existsSync(`${d2}/pit-state.json`)} published ${c2.published.length} ${existsSync(`${d2}/HALT`) ? readFileSync(`${d2}/HALT`, "utf8") : ""}`);
  rmSync(d2, { recursive: true });
  // 13u/13v Ops N-6: the cap is start + 1 day - 15 min (settle looks back 15 min before a day's end).
  for (const [lu, bad, name] of [["2026-11-02T23:45:00.000Z", true, "13u N-6 legacyUntil 23:45Z on pit day 1 (start + 1 day - 15 min): refused"], ["2026-11-02T23:44:59.999Z", false, "13v N-6 legacyUntil 23:44:59.999Z: not refused"]]) {
    const d = setup(); init(d, DAY1, "live", { legacyUntil: lu });
    const cx = mockClient({ staples: day1() });
    let th = ""; try { await rp({ dir: d, client: cx, ...base, now: () => t, sleep: async () => {}, steps: 1 }); } catch (e) { th = e.message; }
    const refused = /legacyUntil .* could hide pit sends/.test(th);
    check(name, refused === bad && (bad ? !existsSync(`${d}/pit-state.json`) : existsSync(`${d}/pit-state.json`)), th);
    rmSync(d, { recursive: true });
  }
}
{
  // 13j Ops O22: the wall-day and hour fee rooms are in the fee-block cap, not only in the quote check.
  for (const [name, pace] of [["wall-day", { wallDayFee: FEE_RAW }], ["hour", { hourFee: FEE_RAW }]]) {
    const dir = setup();
    writeFileSync(`${dir}/SEND`, "on\n");
    const c = mockClient({ staples: day1() });
    c.voteFee = FEE_RAW + 1n; // the quote fits the room exactly; the vote fee at publish time is 1 raw over
    await rp({ dir, client: c, ...base, pace: { gapMs: 0, ...pace }, now: () => Date.parse("2026-11-03T00:11:00Z"), sleep: async () => {}, steps: 1 });
    check(`13j O22 ${name} fee room in the publish cap: a vote fee 1 raw over the room is refused, nothing published`, c.published.length === 0);
    rmSync(dir, { recursive: true });
  }
}
{
  // 13k/13l Ops O23, O25: one leftover alone (pit-sends.json, or pit-init.used) with a missing state and a new pit-init refuses.
  const t = Date.parse("2026-11-03T00:11:00Z");
  for (const keep of ["pit-sends.json", "pit-init.used"]) {
    const dir = setup({ test: true });
    const c = mockClient({ staples: day1() });
    await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
    for (const n of readdirSync(`${dir}/pit-test`)) if (n !== keep) rmSync(`${dir}/pit-test/${n}`, { force: true });
    init(dir, DAY1, "test");
    let threw = ""; try { await rp({ dir, client: c, ...base, now: () => t + 60_000, sleep: async () => {}, steps: 1 }); } catch (e) { threw = e.message; }
    check(`13k O23/O25 only ${keep} left + a new pit-init: refused, no fresh pit`, threw.includes(`but ${keep} exist`) && !existsSync(`${dir}/pit-test/pit-state.json`), threw);
    rmSync(dir, { recursive: true });
  }
}
{
  // 13m Ops O33: the state is bound to the config: no run block, or a run block for another pitDay1, refuses.
  const t = Date.parse("2026-11-03T00:11:00Z");
  for (const [name, edit] of [["no run block", (p) => { delete p.run; }], ["another pitDay1", (p) => { p.run.pitDay1 = "2026-11-01"; }]]) {
    const dir = setup({ test: true });
    const c = mockClient({ staples: day1() });
    await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
    const p = stateOf(dir, "/pit-test"); edit(p); writeFileSync(`${dir}/pit-test/pit-state.json`, pitToJson(p));
    const before = readFileSync(`${dir}/pit-test/pit-state.json`, "utf8");
    let threw = ""; try { await rp({ dir, client: c, ...base, now: () => t + 60_000, sleep: async () => {}, steps: 1 }); } catch (e) { threw = e.message; }
    check(`13m O33 state with ${name}: refused (was made for), HALT, state untouched`, /was made for/.test(threw) && existsSync(`${dir}/pit-test/HALT`) && readFileSync(`${dir}/pit-test/pit-state.json`, "utf8") === before, threw);
    rmSync(dir, { recursive: true });
  }
}
{
  // 13n Ops O35: two open intents (should never happen) hold; nothing is settled, voided or sent.
  const dir = setup();
  writeFileSync(`${dir}/SEND`, "on\n");
  const c = mockClient({ staples: day1(), crash: "before" });
  const t = Date.parse("2026-11-03T00:11:00Z");
  await rp({ dir, client: c, ...base, now: () => t, sleep: async () => {}, steps: 1 });
  const p = stateOf(dir);
  const [k, it] = Object.entries(p.intents).find(([, v]) => v.status === "intent");
  p.intents[`${k}-copy`] = structuredClone(it);
  writeFileSync(`${dir}/pit-state.json`, pitToJson(p));
  await rp({ dir, client: c, ...base, now: () => t + 8 * 60_000, sleep: async () => {}, steps: 1 });
  const q = stateOf(dir);
  check("13n O35 more than one open intent: PAYHOLD, both left open, nothing voided or sent", existsSync(`${dir}/PAYHOLD`) && open(q).length === 2 && c.published.length === 0 && !q.alerts.some((x) => x[1] === "PAYOUT_VOID"));
  rmSync(dir, { recursive: true });
}


// ---- 14. Bob, Oct 26 (Trey's Oct 25 freeze): the LIVE pit 2026-10-29 from the reviewed live config ----
// A: Oct 26-28 are not ladder days. Streak, rank, shields and shields used carry over from the Oct 25 snapshot exactly;
//    the one planned difference is Bob's Oct 26 seeded Practice Shield (non-frozen wallets at streak >= 14 without one).
// B: a fire send from 2026-10-29 00:00Z on, landing while the runner is stopped or still in TEST, counts for pit day 1.
{
  const { shieldView } = await import("./pit-run.mjs");
  const { rungName } = await import("./ladder.mjs");
  const live = JSON.parse(readFileSync(new URL("./ops/pit-config.live-wednesday.json", import.meta.url), "utf8"));
  const snapW = JSON.parse(readFileSync(SNAP, "utf8")).wallets;
  const mk = () => { const dir = mkdtempSync(`${tmpdir()}/pit-carry-`); writeFileSync(`${dir}/pit-config.json`, JSON.stringify({ ...live, ladderSeed: SNAP, publicDir: `${dir}/www` })); init(dir, "2026-10-29", "live"); return dir; };
  // carry: every field of the card's ladder record, pit vs snapshot. Returns the differing wallets (seeded practice listed apart).
  const carry = (pit) => {
    const bad = []; const seeded = [];
    for (const [w, v] of Object.entries(snapW)) {
      const lw = pit.ladder[w]; if (!lw) { bad.push(`${w.slice(-6)}:missing`); continue; }
      const want = structuredClone(v.ladder.shields); if (lw.seeded_practice) { want.practice.held = true; seeded.push(w.slice(-4)); }
      const got = { s: lw.streak, r: lw.best >= 0 ? rungName(lw.best) : null, sh: JSON.stringify(shieldView(lw)), u: lw.used_total };
      const exp = { s: v.mining_streak, r: v.rank_rung_from_streak, sh: JSON.stringify(want), u: v.ladder.shieldsUsed };
      if (JSON.stringify(got) !== JSON.stringify(exp)) bad.push(`${w.slice(-6)}:${JSON.stringify(got)}!=${JSON.stringify(exp)}`);
    }
    if (Object.keys(pit.ladder).length !== Object.keys(snapW).length) bad.push(`ladder has ${Object.keys(pit.ladder).length} wallets`);
    return { bad, seeded };
  };
  const cfgL = readConfig(mk());
  check("14a live config: pit day 1 2026-10-29 starts 00:00Z, ladderLast 2026-10-28", !cfgL.test && cfgL.startMs === Date.parse("2026-10-29T00:00:00Z") && cfgL.ladderLast === "2026-10-28");
  const seed = carry(freshPit(cfgL));
  check("14b A: fresh live pit == Oct 25 snapshot for all 17 wallets (streak, rank, shields, used); only hd2i's seeded Practice Shield differs", seed.bad.length === 0 && seed.seeded.join() === "hd2i", `${seed.bad.join(" ")} seeded ${seed.seeded.join()}`);
  // The runner: TEST until U2, first LIVE start Wed 9:40 PM ET (01:40Z) with sends already on chain from 00:00Z on.
  const sends = [
    staple("2026-10-28T23:59:59.000Z", [{ from: W2, ops: [{ token: BASE, amount: K(5) }] }]), // Wed 7:59:59 PM ET: before pit day 1
    staple("2026-10-29T00:00:00.000Z", [{ from: W1, ops: [{ token: BASE, amount: K(3) }] }]), // 8:00 PM ET sharp
    staple("2026-10-29T00:20:00.000Z", [{ from: ADDR.hd2i, ops: [{ token: BASE, amount: K(2) }] }]), // runner in TEST
    staple("2026-10-29T01:35:00.000Z", [{ from: W3, ops: [{ token: BASE, amount: K(1) }] }]), // runner stopped by U2
  ];
  const dir = mk(); writeFileSync(`${dir}/SEND`, "on\n");
  const client = mockClient({ staples: sends });
  const ck = clock("2026-10-29T01:42:00.000Z");
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: ck.now, sleep: ck.sleep, steps: 1, ...quiet });
  const first = stateOf(dir);
  const mid = carry(first);
  check("14c A: after the first LIVE start (Wed 9:42 PM ET) the ladder is still the snapshot carry-over, nothing closed", mid.bad.length === 0 && first.last_pit_closed === null && first.lmeta.last === "2026-10-28" && Object.keys(first.closed).length === 0, mid.bad.join(" "));
  const st = JSON.parse(readFileSync(`${dir}/pit-sends.json`, "utf8"));
  const seen = (st.byDay["2026-10-29"] ?? []).map((x) => x.from).sort();
  check("14d B: the first LIVE pass backfilled the 00:00Z, 00:20Z and 01:35Z sends into 2026-10-29 from history, not the 7:59 PM one", JSON.stringify(seen) === JSON.stringify([ADDR.hd2i, W1, W3].sort()) && !Object.values(st.byDay).flat().some((x) => x.from === W2), seen.join(","));
  ck.set("2026-10-30T00:11:00.000Z");
  await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: ck.now, sleep: ck.sleep, steps: 1, ...quiet });
  const p = stateOf(dir); const m = p.alloc["2026-10-29"]?.miners ?? {};
  check("14e B: Thursday 8:11 PM ET close counts all three for pit day 1 (3 + 2 + 1 KTA), not W2's Oct 28 send", p.last_pit_closed === "2026-10-29" && m[W1] === K(3) && m[ADDR.hd2i] === K(2) && m[W3] === K(1) && !(W2 in m), JSON.stringify(m, (k, v) => (typeof v === "bigint" ? String(v) : v)));
  const h = p.ladder[ADDR.hd2i]; const zb = p.ladder[ADDR.testB];
  check("14f A: the first ladder day is 2026-10-29 (no Oct 26-28 step): hd2i 15 -> 16 with its shield; frozen aabz6zxb 15 unchanged; senders W1/W3 at 1", p.lmeta.last === "2026-10-29" && h.streak === 16 && h.shields === 1 && h.used_total === 0 && zb.streak === 15 && zb.frozen && p.ladder[W1].streak === 1 && p.ladder[W3].streak === 1);
  const s13 = Object.entries(snapW).filter(([w, v]) => v.mining_streak === 13).map(([w]) => p.ladder[w].streak);
  check("14g a 13-streak wallet that does not send on pit day 1 resets at that close (the normal day-1 miss, not Oct 26-28)", s13.length === 5 && s13.every((x) => x === 0), s13.join());
  rmSync(dir, { recursive: true });
}

// ---- 14h. Trey, Oct 26 3:36 PM plan: TEST -> LIVE on Wed Oct 28 MORNING (about 11 AM ET), 13 h before pit day 1 opens ----
// The LIVE runner is up and passing all Wednesday afternoon. Wednesday sends must not count, the carry-over must hold, and
// sends from 00:00Z on must count at the Thursday 8:10 PM ET close, with the chain growing between passes.
{
  const { rungName } = await import("./ladder.mjs");
  const live = JSON.parse(readFileSync(new URL("./ops/pit-config.live-wednesday.json", import.meta.url), "utf8"));
  const snapW = JSON.parse(readFileSync(SNAP, "utf8")).wallets;
  const dir = mkdtempSync(`${tmpdir()}/pit-wed-`); writeFileSync(`${dir}/pit-config.json`, JSON.stringify({ ...live, ladderSeed: SNAP, publicDir: `${dir}/www` })); init(dir, "2026-10-29", "live");
  writeFileSync(`${dir}/SEND`, "on\n");
  const client = mockClient({ staples: [staple("2026-10-28T14:00:00.000Z", [{ from: W1, ops: [{ token: BASE, amount: K(7) }] }])] });
  const ck = clock("2026-10-28T15:00:00.000Z");
  const pass = async (at) => { ck.set(at); await rp({ dir, client, base: BASE, baseText: BASE, koreAccount, accountFrom, now: ck.now, sleep: ck.sleep, steps: 1, ...quiet }); };
  await pass("2026-10-28T15:00:00.000Z"); // Wed 11 AM ET: the WED box's first LIVE pass
  const p0 = stateOf(dir);
  check("14h Wed 11 AM ET LIVE start: seeded, nothing closed, ladder last 2026-10-28, no send", existsSync(`${dir}/pit-init.used`) && p0.last_pit_closed === null && p0.lmeta.last === "2026-10-28" && client.published.length === 0);
  client.staples.push(staple("2026-10-28T20:00:00.000Z", [{ from: W2, ops: [{ token: BASE, amount: K(5) }] }])); // Wed 4 PM ET
  await pass("2026-10-28T20:05:00.000Z");
  client.staples.push(staple("2026-10-28T23:59:59.999Z", [{ from: W3, ops: [{ token: BASE, amount: K(9) }] }])); // 1 ms before day 1
  await pass("2026-10-28T23:59:59.999Z");
  client.staples.push(staple("2026-10-29T00:00:00.000Z", [{ from: W1, ops: [{ token: BASE, amount: K(3) }] }]));
  await pass("2026-10-29T00:00:30.000Z");
  client.staples.push(staple("2026-10-29T12:00:00.000Z", [{ from: ADDR.hd2i, ops: [{ token: BASE, amount: K(2) }] }]));
  await pass("2026-10-29T12:01:00.000Z");
  client.staples.push(staple("2026-10-29T23:59:59.000Z", [{ from: W3, ops: [{ token: BASE, amount: K(1) }] }]));
  await pass("2026-10-30T00:00:30.000Z");
  const pm = stateOf(dir);
  check("14i Wed afternoon to Thu 8 PM ET: no close yet, the ladder is still the snapshot carry-over (streaks, ranks)", pm.last_pit_closed === null && pm.lmeta.last === "2026-10-28" && Object.entries(snapW).every(([w, v]) => pm.ladder[w].streak === v.mining_streak && (pm.ladder[w].best >= 0 ? rungName(pm.ladder[w].best) : null) === v.rank_rung_from_streak));
  await pass("2026-10-30T00:11:00.000Z");
  const p = stateOf(dir); const m = p.alloc["2026-10-29"]?.miners ?? {};
  check("14j Thu 8:11 PM ET close: only the 00:00Z, 12:00Z and 23:59:59Z sends count (3 + 2 + 1); Wed sends (14:00Z before the start, 20:00Z, 23:59:59.999Z) do not", p.last_pit_closed === "2026-10-29" && m[W1] === K(3) && m[ADDR.hd2i] === K(2) && m[W3] === K(1) && !(W2 in m) && Object.keys(m).length === 3, JSON.stringify(m, (k, v) => (typeof v === "bigint" ? String(v) : v)));
  check("14k ladder after the close: first step is 2026-10-29; hd2i 16, frozen aabz6zxb 15", p.lmeta.last === "2026-10-29" && p.ladder[ADDR.hd2i].streak === 16 && p.ladder[ADDR.testB].streak === 15);
  rmSync(dir, { recursive: true });
}

console.log(failed ? `PIT_RUN_CHECK_FAIL ${failed}` : "PIT_RUN_CHECK_PASS");
process.exit(failed ? 1 : 0);
