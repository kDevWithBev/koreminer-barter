// fix/rate-hold behaviour tests (G2-G8, G10, G11). Fake clock and fake chain; no network, no seed.
// Each check runs the real runShaft over several ticks. Set RH_SOFT=1 to list every failure instead of stopping at the first.
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { booksToJson, createBooks } from "./books.mjs";
import { startMs } from "./ledger.mjs";
import { FEE_PER_TX, blocksInHour, bundleCap, configLine, fromKta, maxBlocksPerHour, payoutFeeBudget, payoutFeeCap } from "./pace.mjs";
import { ALICE, aliceDue, makeBooks, makeClient } from "./fee-harness.mjs";
import { runShaft } from "./run.mjs";

const soft = process.env.RH_SOFT === "1";
const say = console.log;
const yell = console.error;
let passed = 0;
const failed = [];
function check(name, ok, extra = "") {
  if (!ok) {
    if (!soft) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
    failed.push(name);
    say("FAIL", name);
    return;
  }
  passed += 1;
  say("ok", name);
}

const HOUR = 3_600_000;
const start = Date.parse("2026-10-24T15:00:00.000Z");
const STATUS_KEYS = "blocksLastHour,limit,reason,since,state";

function makeDir({ books, send = false, state = null, files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "kore-rh-"));
  writeFileSync(join(dir, "books.json"), JSON.stringify(booksToJson(books)));
  if (send) writeFileSync(join(dir, "SEND"), "on\n");
  if (state) writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function baseState(extra = {}) {
  return { windowStart: start, spent: "0", feePerTx: FEE_PER_TX.toString(), payoutDay: "2026-10-24", done: [], closeOpen: false, ...extra };
}

function stamp(client, time) {
  const orig = client.publishBuilder.bind(client);
  client.publishBuilder = async (...args) => {
    const before = client.publishes.length;
    const at = time.t;
    const result = await orig(...args);
    if (client.publishes.length > before) client.publishes[client.publishes.length - 1].at = at;
    return result;
  };
}

async function tick(dir, client, time, steps, onSleep = null) {
  const logs = [];
  const errors = [];
  const sleeps = [];
  console.log = (...a) => { logs.push(a.map(String).join(" ")); };
  console.error = (...a) => { errors.push(a.map(String).join(" ")); };
  try {
    await runShaft({
      dir, client, base: { id: "base" }, baseText: "base", dustAccount: { id: "dust" }, koreAccount: { id: "kore" },
      accountFrom: () => ({ id: "dest" }), now: () => time.t,
      sleep: async (ms) => { time.t += ms; sleeps.push(ms); if (onSleep) await onSleep({ ms, time, sleeps, client, dir }); },
      steps,
    });
  } finally {
    console.log = say;
    console.error = yell;
  }
  return { logs, errors, sleeps };
}

const show = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x));

const intake = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const sink = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const id = (value) => ({ publicKeyString: { toString: () => value } });
// A long run: 400 KTA of fuel and a chain that shows each pick, as in fee-site-rate-check.
function fuelled(time) {
  const books = createBooks(startMs, fromKta("400"));
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  let n = 0;
  client.getHistory = async () => {
    n += 1;
    return [{ voteStaple: { blocksHash: { toString: () => `heal-${time.t}-${n}` }, timestamp: () => new Date(time.t), blocks: [{ account: id(intake), operations: [{ type: 0, to: id(sink), token: id("base"), amount: 1n }] }] } }];
  };
  stamp(client, time);
  return { books, client };
}
const alerts = (errors) => errors.filter((l) => l.startsWith("ALERT "));
const picks = (client) => client.publishes.filter((r) => r.kind === "pick");
const pays = (client) => client.publishes.filter((r) => r.kind === "payout");
const state = (dir) => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
const status = (dir) => { try { return JSON.parse(readFileSync(join(dir, "status.json"), "utf8")); } catch { return null; } };
const has = (dir, f) => existsSync(join(dir, f));

delete process.env.PICKS_OFF;
delete process.env.MAX_BLOCKS_PER_HOUR;
delete process.env.FEE_CAP_PER_BUNDLE_KTA;
delete process.env.PAYOUT_FEE_CAP_KTA;
delete process.env.PAYOUT_FEE_BUDGET_KTA_PER_DAY;

// G6/G10: pre-start fee over the cap -> one SKIP line, FEEHOLD, one ALERT, 0 publishes.
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.06"), voteFee: fromKta("0.06") });
  const time = { t: start };
  const dir = makeDir({ books });
  const r = await tick(dir, client, time, 6);
  const skips = r.logs.filter((l) => l.startsWith("SKIP: "));
  check("G6 over-cap at start prints one SKIP line", skips.length === 1 && skips[0] === "SKIP: fee 0.06000 KTA a block is over the 0.05000 KTA cap. Picks not started.", skips.join("\n"));
  check("G6 over-cap at start publishes nothing", client.publishes.length === 0 && client.feeBlockBuilds === 0, show(client.publishes));
  check("G4 over-cap at start writes FEEHOLD and one ALERT that says ask Keeta", has(dir, "FEEHOLD") && alerts(r.errors).length === 1 && alerts(r.errors)[0].includes("Ask Keeta"), r.errors.join("\n"));
  const st = status(dir);
  check("G9 status.json says paused FEEHOLD with only state, reason, since, count, limit", st && st.state === "paused" && st.reason.startsWith("FEEHOLD:") && Object.keys(st).sort().join(",") === STATUS_KEYS, JSON.stringify(st));
  check("G9 FEEHOLD pause line is printed", r.logs.some((l) => l.startsWith("Paused: FEEHOLD ")), r.logs.join("\n"));
}

// G6: RPC error and empty quotes at start -> SKIP, no publish, no FEEHOLD; retries in 10 minutes and starts when quotes work.
for (const kind of ["throw", "null", "empty"]) {
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const real = client.getQuotes.bind(client);
  let bad = 2;
  client.getQuotes = async (blocks) => {
    if (bad > 0) {
      bad -= 1;
      if (kind === "throw") throw new Error("rpc down");
      return kind === "null" ? null : [];
    }
    return real(blocks);
  };
  const time = { t: start };
  const dir = makeDir({ books });
  const r = await tick(dir, client, time, 50);
  const skipIdx = r.logs.findIndex((l) => l === "SKIP: no usable fee quote. Picks not started.");
  const okIdx = r.logs.findIndex((l) => l.startsWith("Fee check ok: 0.00600 KTA a block, cap 0.05000 KTA. Picks start."));
  check(`G6 ${kind} quote at start skips, holds no file, then starts after the 10 min retry`, skipIdx >= 0 && okIdx > skipIdx && !has(dir, "FEEHOLD") && !r.sleeps.includes(600_000) && r.sleeps.slice(0, 22).reduce((a, b) => a + b, 0) >= 600_000 && picks(client).length >= 1, r.logs.join("\n"));
}

// G6: non-KTA fee at start -> SKIP and FEEHOLD.
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006") });
  client.getQuotes = async (blocks) => blocks.map(() => ({ fee: { amount: fromKta("0.001"), token: { id: "usdc" } } }));
  const time = { t: start };
  const dir = makeDir({ books });
  const r = await tick(dir, client, time, 3);
  check("G6 non-KTA quote at start skips and writes FEEHOLD", r.logs.includes("SKIP: the quote is not in KTA. Picks not started.") && has(dir, "FEEHOLD") && client.publishes.length === 0, r.logs.join("\n"));
}

// G4: mid-run fee over the cap -> FEEHOLD, one ALERT, no further picks, no auto-resume when the fee drops.
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const time = { t: start };
  const dir = makeDir({ books });
  let raised = false;
  const r = await tick(dir, client, time, 12, ({ client: c, sleeps }) => {
    if (!raised && picks(c).length === 2) { raised = true; c.pickQuote = fromKta("0.07"); c.voteFee = fromKta("0.07"); }
    if (raised && sleeps.length === 8) { c.pickQuote = fromKta("0.006"); c.voteFee = fromKta("0.006"); }
  });
  check("G4 mid-run over-cap stops picks at 2 and writes FEEHOLD", picks(client).length === 2 && has(dir, "FEEHOLD"), show(client.publishes));
  check("G4 mid-run over-cap alerts once", alerts(r.errors).length === 1 && alerts(r.errors)[0] === "ALERT Fee 0.07000 KTA is over the 0.05000 KTA cap. Picks paused (FEEHOLD). Ask Keeta before removing FEEHOLD.", alerts(r.errors).join("\n"));
  // Resume only after a person removes the file: a fresh pre-start check runs first.
  try { unlinkSync(join(dir, "FEEHOLD")); } catch { /* the check above already failed */ }
  const again = await tick(dir, client, time, 3);
  check("G4 picks resume only after FEEHOLD is removed, with a new fee check", again.logs.some((l) => l.startsWith("Fee check ok: ")) && again.logs.includes("Resumed.") && picks(client).length >= 3, again.logs.join("\n"));
  check("G9 status.json is running again after the resume", status(dir)?.state === "running", JSON.stringify(status(dir)));
}

// G3: FEEHOLD pauses picks only; a due payout still goes out at the close.
{
  const books = makeBooks(true);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") });
  const time = { t: start };
  const dir = makeDir({ books, send: true, state: baseState({ closeOpen: true }), files: { FEEHOLD: "test hold\n" } });
  const r = await tick(dir, client, time, 3);
  check("G3 FEEHOLD at start: payout still paid, 0 picks", pays(client).length === 1 && picks(client).length === 0, show(client.publishes));
  check("G3 FEEHOLD at start prints the pause line", r.logs.some((l) => l === "Paused: FEEHOLD test hold. Picks paused. Payouts still run."), r.logs.join("\n"));
}

// G3/G8: restart with RATEHOLD present -> nothing publishes, not the signed block, not a payout, not a pick.
{
  const books = makeBooks(true);
  const client = makeClient(books, {
    pickQuote: fromKta("0.006"),
    payoutQuote: fromKta("0.00404"),
    pending: { date: new Date(start - 1000), blocks: [{ operations: [{ type: 0, token: { id: "base" }, amount: 1n }] }] },
  });
  const time = { t: start };
  const dir = makeDir({ books, send: true, state: baseState({ closeOpen: true }), files: { RATEHOLD: "test rate hold\n" } });
  const r = await tick(dir, client, time, 5);
  check("G3 RATEHOLD at start: 0 publishes of any kind, no recover", client.publishes.length === 0 && client.recoverCalls === 0, show(client.publishes));
  check("G3 RATEHOLD at start prints the pause line and status", r.logs.some((l) => l === "Paused: RATEHOLD test rate hold. Nothing publishes.") && status(dir)?.reason?.startsWith("RATEHOLD:"), r.logs.join("\n"));
  check("G3 RATEHOLD leaves the alice payout queued", aliceDue(books) > 0n && !has(dir, "payout-intent.json"));
}

// G7/G10: the 61st ledger block in the rolling hour trips RATEHOLD; nothing after.
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const time = { t: start };
  const dir = makeDir({ books, state: baseState({ recent: [[start - 10 * 60_000, 58]] }) });
  const r = await tick(dir, client, time, 8);
  check("G10 58 in the hour: one more publish (60), then the next trips", picks(client).length === 1 && has(dir, "RATEHOLD"), show(client.publishes));
  check("G10 the rate trip alerts once and says remove only after review", alerts(r.errors).length === 1 && alerts(r.errors)[0].startsWith("ALERT Rate cap: 60 ledger blocks in the last hour") && alerts(r.errors)[0].includes("All publishing paused (RATEHOLD)"), alerts(r.errors).join("\n"));
  check("G10 nothing publishes after the trip", r.logs.filter((l) => l.startsWith("Paused: RATEHOLD ")).length >= 1 && picks(client).length === 1);
  check("G10 status.json says paused RATEHOLD with the count", status(dir)?.state === "paused" && status(dir)?.reason.startsWith("RATEHOLD:") && status(dir)?.blocksLastHour === 60, JSON.stringify(status(dir)));
  try { unlinkSync(join(dir, "RATEHOLD")); } catch { /* the check above already failed */ }
  time.t = start + HOUR + 60_000;
  const later = await tick(dir, client, time, 3);
  check("G10 after a person removes RATEHOLD and the hour rolls, picks resume", picks(client).length >= 2 && later.logs.includes("Resumed."), later.logs.join("\n"));
}

// G8: payouts are counted too. 59 in the hour, a due payout (2 blocks) trips RATEHOLD with no intent written.
{
  process.env.PICKS_OFF = "1";
  const books = makeBooks(true);
  const client = makeClient(books, { payoutQuote: fromKta("0.00404") });
  const time = { t: start };
  const dir = makeDir({ books, send: true, state: baseState({ closeOpen: true, recent: [[start - 60_000, 59]] }) });
  const r = await tick(dir, client, time, 3);
  delete process.env.PICKS_OFF;
  check("G8 a payout that would make 61 trips RATEHOLD and is not sent", pays(client).length === 0 && has(dir, "RATEHOLD") && !has(dir, "payout-intent.json") && aliceDue(books) > 0n, show({ pubs: client.publishes, errors: r.errors }));
}

// G7: steady picks for 3 hours never pass 60 ledger blocks in any rolling hour and never trip.
{
  const time = { t: start };
  const { books, client } = fuelled(time);
  const dir = makeDir({ books });
  await tick(dir, client, time, 120);
  const at = picks(client).map((p) => p.at);
  let worst = 0;
  for (const t of at) worst = Math.max(worst, at.filter((x) => x > t - HOUR && x <= t).length * 2);
  check("G7 three steady hours: at most 60 ledger blocks in any rolling hour, no RATEHOLD", at.length >= 60 && worst <= 60 && !has(dir, "RATEHOLD"), JSON.stringify({ n: at.length, worst }));
  check("G7 a full hour is 30 publishes (60 ledger blocks)", at.filter((x) => x < start + HOUR).length === 30, String(at.filter((x) => x < start + HOUR).length));
}

// G7: the count survives a restart.
{
  const time = { t: start };
  const { books, client } = fuelled(time);
  const dir = makeDir({ books });
  await tick(dir, client, time, 10);
  const n1 = picks(client).length;
  const saved = state(dir).recent;
  check("G7 state.json saves the rolling hour", n1 >= 5 && Array.isArray(saved) && saved.reduce((s, [, n]) => s + n, 0) === n1 * 2, JSON.stringify(saved));
  const r2 = await tick(dir, client, time, 0);
  const line = r2.logs.find((l) => l.startsWith("Config fee cap "));
  check("G11 restart config line shows the hard limits and the saved count", line && line.includes("Hard limits 0.05000 KTA a block, 60 ledger blocks an hour") && line.includes(`Last hour ${n1 * 2} ledger blocks.`), line);
}

// G7: a publish whose result is unknown (timeout) still counts.
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  client.publishBuilder = async () => { throw new Error("timeout"); };
  const time = { t: start };
  const dir = makeDir({ books });
  const r = await tick(dir, client, time, 1);
  check("G7 a timed-out publish is counted as 2 ledger blocks", blocksInHour(state(dir).recent, time.t) === 2 && r.errors.some((l) => l.startsWith("Retry.")), JSON.stringify(state(dir).recent));
}

// G7: the clock going back does not reset the window (future entries still count).
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const time = { t: start };
  const dir = makeDir({ books, state: baseState({ recent: [[start + 2 * HOUR, 59]], lastPublishMs: start + 2 * HOUR }) });
  await tick(dir, client, time, 4);
  check("G7 entries dated in the future still count after the clock goes back", picks(client).length === 0 && has(dir, "RATEHOLD"), show(client.publishes));
}

// G2: hard ceilings, the env can lower but not raise.
{
  process.env.MAX_BLOCKS_PER_HOUR = "600";
  process.env.FEE_CAP_PER_BUNDLE_KTA = "0.5";
  process.env.PAYOUT_FEE_CAP_KTA = "10";
  process.env.PAYOUT_FEE_BUDGET_KTA_PER_DAY = "100";
  check("G2 600 blocks an hour clamps to 60", maxBlocksPerHour() === 60);
  check("G2 0.5 KTA fee cap clamps to 0.05", bundleCap() === fromKta("0.05"));
  check("G2 payout cap 10 clamps to 0.05 and budget 100 to 0.5", payoutFeeCap() === fromKta("0.05") && payoutFeeBudget() === fromKta("0.5"));
  check("G11 config line names the clamp and the hard limits", configLine(4).includes("(clamped from 0.50000 KTA, 600/hour, payout cap 10.00000 KTA, payout budget 100.00000 KTA)") && configLine(4).includes("Last hour 4 ledger blocks."), configLine(4));
  // With 600 in the env, a running hour still holds 30 publishes.
  const time = { t: start };
  const { books, client } = fuelled(time);
  const dir = makeDir({ books });
  await tick(dir, client, time, 40);
  check("G2 env 600 still gives 30 publishes in the hour", picks(client).filter((p) => p.at < start + HOUR).length === 30);
  process.env.MAX_BLOCKS_PER_HOUR = "20";
  process.env.FEE_CAP_PER_BUNDLE_KTA = "0.01";
  check("G2 the env can lower both", maxBlocksPerHour() === 20 && bundleCap() === fromKta("0.01"));
  for (const k of ["MAX_BLOCKS_PER_HOUR", "FEE_CAP_PER_BUNDLE_KTA", "PAYOUT_FEE_CAP_KTA", "PAYOUT_FEE_BUDGET_KTA_PER_DAY"]) delete process.env[k];
}

// r2 (Ops review B2): the first status write of each process is unconditional, and it happens at startup.
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const time = { t: start };
  const old = JSON.stringify({ state: "running", reason: "picks off", since: "2000-01-01T00:00:00.000Z", blocksLastHour: 0, limit: 60 });
  process.env.PICKS_OFF = "1";
  const dir = makeDir({ books, files: { "status.json": old } });
  await tick(dir, client, time, 0);
  const st = status(dir);
  check("B2 startup rewrites a same-key status.json left by an earlier run (since is this start)", st && st.state === "running" && st.reason === "picks off" && st.since === new Date(start).toISOString(), JSON.stringify(st));
  delete process.env.PICKS_OFF;
  const dir2 = makeDir({ books: makeBooks(false) });
  await tick(dir2, makeClient(makeBooks(false), { pickQuote: fromKta("0.006") }), { t: start }, 0);
  check("B2 startup writes status.json before the loop runs", status(dir2)?.state === "running" && status(dir2)?.reason === "starting", JSON.stringify(status(dir2)));
  const dir3 = makeDir({ books: makeBooks(false), files: { RATEHOLD: "review\n" } });
  await tick(dir3, makeClient(makeBooks(false), { pickQuote: fromKta("0.006") }), { t: start }, 0);
  check("B2 startup with RATEHOLD writes paused", status(dir3)?.state === "paused" && status(dir3)?.reason.startsWith("RATEHOLD:"), JSON.stringify(status(dir3)));
}

// r2 (Ops B4): one publish timeout at full pace keeps the 120 s gap and does not trip RATEHOLD.
{
  const time = { t: start };
  const { books, client } = fuelled(time);
  const real = client.publishBuilder.bind(client);
  let n = 0;
  const tries = [];
  client.publishBuilder = async (...a) => { n += 1; tries.push(time.t); if (n === 40) throw new Error("timeout"); return real(...a); };
  const dir = makeDir({ books });
  const r = await tick(dir, client, time, 120);
  const gaps = tries.slice(1).map((t, i) => t - tries[i]);
  check("B4 one timeout at full pace: no RATEHOLD, no ALERT, picks go on", !has(dir, "RATEHOLD") && alerts(r.errors).length === 0 && picks(client).length >= 100, `${picks(client).length} ${r.errors.join("\n")}`);
  check("B4 every publish attempt, the failed one included, is at least 120 s after the last", gaps.length > 50 && gaps.every((g) => g >= 120_000), JSON.stringify(gaps.filter((g) => g < 120_000)));
}

// r2 (Ops B5): no usable quote at start: the loop sleeps 30 s, payouts still go out, STOP is seen within 30 s.
{
  const books = makeBooks(true);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") });
  const realQ = client.getQuotes.bind(client);
  client.getQuotes = async (blocks) => (blocks.some((b) => (b.operations ?? []).some((o) => o.token?.id === "kore")) ? realQ(blocks) : null);
  const time = { t: start };
  const dir = makeDir({ books, send: true, state: baseState({ closeOpen: true }) });
  let stopAt = null;
  const r = await tick(dir, client, time, 40, ({ sleeps, dir: d, time: tm }) => { if (sleeps.length === 6 && stopAt === null) { stopAt = tm.t; writeFileSync(join(d, "STOP"), "x\n"); } });
  check("B5 no quote: no 10 min sleep in the loop, and a due payout still goes out", !r.sleeps.includes(600_000) && Math.max(...r.sleeps) <= 120_000 && pays(client).length >= 1, JSON.stringify(r.sleeps));
  check("B5 no quote: STOP is seen at the next loop (no long sleep after it)", stopAt !== null && r.sleeps.length === 6 && time.t === stopAt, JSON.stringify(r.sleeps));
}

// r2 (nit): HALT is checked every loop.
{
  const time = { t: start };
  const { books, client } = fuelled(time);
  const dir = makeDir({ books });
  let at = null;
  const r = await tick(dir, client, time, 60, ({ client: c, dir: d }) => { if (at === null && picks(c).length >= 5) { at = picks(c).length; writeFileSync(join(d, "HALT"), "x\n"); } });
  check("r2 HALT appearing mid-run stops the loop with no further publish", at === 5 && picks(client).length === 5 && r.logs.includes("HALT file present. Stopping."), `${at} ${picks(client).length}`);
}

// r2 (nit): a corrupt state.json fails safe into RATEHOLD instead of resetting the count.
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const time = { t: start };
  const bad = '{"recent":[[' + (start - 60000) + ',58]],"windowStart":';
  const dir = makeDir({ books, files: { "state.json": bad } });
  const r = await tick(dir, client, time, 6);
  check("r2 corrupt state.json writes RATEHOLD, one ALERT, publishes nothing, keeps a copy", has(dir, "RATEHOLD") && client.publishes.length === 0 && alerts(r.errors).length === 1 && readFileSync(join(dir, "state.json.bad"), "utf8") === bad, r.errors.join("\n"));
  const dir2 = makeDir({ books: makeBooks(false) });
  const c2 = makeClient(makeBooks(false), { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  await tick(dir2, c2, { t: start }, 6);
  check("r2 a missing state.json is a normal first start (no RATEHOLD)", !has(dir2, "RATEHOLD") && picks(c2).length >= 1);
}

// r2 (nit): an entry over 100 blocks is capped at 100, not dropped; odd counts round up.
{
  const { pruneRecent } = await import("./pace.mjs");
  check("r2 pruneRecent caps 150 at 100 and rounds 2.5 up to 3", JSON.stringify(pruneRecent([[start, 150], [start, 2.5]], start)) === JSON.stringify([[start, 100], [start, 3]]) && blocksInHour([[start, 150]], start) === 100);
}

// r2 (nit): status.json's block count follows the rolling count, not only state changes.
{
  const time = { t: start };
  const { books, client } = fuelled(time);
  const dir = makeDir({ books });
  await tick(dir, client, time, 12);
  const st = status(dir);
  const live = blocksInHour(state(dir).recent, time.t);
  check("r2 status.json blocksLastHour matches the saved rolling count while picks run", st && st.reason === "picks on" && live >= 10 && st.blocksLastHour === live, `${JSON.stringify(st)} live ${live}`);
}

// No refund path anywhere in the runner, and the runner never removes a hold file.
{
  const run = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const pace = readFileSync(new URL("./pace.mjs", import.meta.url), "utf8");
  check("no refund call in run.mjs or pace.mjs", !/refund/i.test(run) && !/refund/i.test(pace));
  check("the runner never deletes FEEHOLD or RATEHOLD", !/unlinkSync\([^)]*(feeHoldPath|rateHoldPath|FEEHOLD|RATEHOLD)/.test(run));
}

console.log("rate-hold checks", passed, failed.length ? `failed ${failed.length}` : "");
if (failed.length) process.exit(1);
