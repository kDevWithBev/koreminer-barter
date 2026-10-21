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


delete process.env.PICKS_OFF; delete process.env.MAX_BLOCKS_PER_HOUR; delete process.env.FEE_CAP_PER_BUNDLE_KTA;
const out = (k, v) => say(`NEG ${k}: ${v}`);
const worstReal = (ats) => { let w = 0; for (const t of ats) w = Math.max(w, ats.filter((x) => x > t - HOUR && x <= t).length * 2); return w; };

// N1 clock forward jump of 61 min after 40 min of steady picks.
{
  const time = { t: start };
  const { books, client } = fuelled(time);
  const dir = makeDir({ books });
  const J = 61 * 60_000; let jumped = null;
  await tick(dir, client, time, 70, ({ time: tm }) => { if (jumped === null && tm.t >= start + 40 * 60_000) { jumped = tm.t; tm.t += J; } });
  const real = picks(client).map((p) => (jumped !== null && p.at >= jumped + J ? p.at - J : p.at));
  out("N1 forward jump 61 min: worst ledger blocks in a REAL rolling hour", `${worstReal(real)} (cap 60), RATEHOLD=${has(dir, "RATEHOLD")}`);
}
// N2 one unknown-result publish (timeout) at full pace.
{
  const time = { t: start };
  const { books, client } = fuelled(time);
  const real = client.publishBuilder.bind(client); let n = 0;
  client.publishBuilder = async (...a) => { n += 1; if (n === 40) throw new Error("timeout"); return real(...a); };
  const dir = makeDir({ books });
  const r = await tick(dir, client, time, 120);
  out("N2 one timeout at full pace", `RATEHOLD=${has(dir, "RATEHOLD")} picks=${picks(client).length} alerts=${alerts(r.errors).length} ${alerts(r.errors)[0] ?? ""}`);
}
// N3 pre-start check with no quote: the 10-min sleep also delays the loop (payouts, STOP, RATEHOLD checks).
{
  const books = makeBooks(true);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") });
  const realQ = client.getQuotes.bind(client);
  client.getQuotes = async (blocks) => (blocks.some((b) => (b.operations ?? []).some((o) => o.token?.id === "kore")) ? realQ(blocks) : null);
  const time = { t: start };
  const dir = makeDir({ books, send: true, state: baseState({ closeOpen: true }) });
  const r = await tick(dir, client, time, 4);
  out("N3 no pick quote, picks on", `loop sleeps ${JSON.stringify(r.sleeps)} payouts=${pays(client).length}`);
}
// N4 corrupt state.json resets the rolling count.
{
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const time = { t: start };
  const dir = makeDir({ books, files: { "state.json": '{"recent":[[' + (start - 60000) + ',58]],"windowStart":' } });
  await tick(dir, client, time, 6);
  out("N4 corrupt state.json with 58 in the hour", `picks=${picks(client).length} RATEHOLD=${has(dir, "RATEHOLD")}`);
}
// N5 an entry with n>100 is dropped by pruneRecent.
{
  const { pruneRecent } = await import("./pace.mjs");
  out("N5 pruneRecent([[now,150]])", JSON.stringify(pruneRecent([[start, 150]], start)) + " blocksInHour=" + blocksInHour([[start, 150]], start));
}
// N6 payout fee budget at the cap fee: 11 payouts x 0.05 vs 0.5/day.
out("N6 11 payouts at 0.05 cap", `${(11 * 0.05).toFixed(2)} KTA > budget ${Number(payoutFeeBudget()) / 1e18} -> the 11th waits for the next UTC day; observed 11 x 0.00404 = ${(11 * 0.00404).toFixed(5)}`);
