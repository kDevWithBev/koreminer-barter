// Close-accrue checks. No network. No real seed. client.send and client.recover stay unused.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { accounted, booksFromJson, booksToJson, createBooks } from "./books.mjs";
import { BRIDGE } from "./claim.mjs";
import { makeClient } from "./fee-harness.mjs";
import { DAY_MS, dayBudget, dayStart } from "./ledger.mjs";
import { choosePayout } from "./pay.mjs";
import { FEE_PER_TX, fromKta, payoutFeeBudget } from "./pace.mjs";
import { runShaft } from "./run.mjs";
import { accrue, deposit, due } from "./share.mjs";

const LAST = Date.parse("2026-10-20T03:59:39.616Z");
const EDGE = Date.parse("2026-10-21T00:00:00.000Z");
const T2358 = Date.parse("2026-10-20T23:58:00.000Z");
const T0030 = Date.parse("2026-10-21T00:00:30.000Z");
const T0100 = Date.parse("2026-10-21T00:01:00.000Z");
const T0201 = Date.parse("2026-10-21T00:02:01.000Z");
const T0300 = Date.parse("2026-10-21T00:03:00.000Z");
const T3001 = Date.parse("2026-10-21T00:30:01.000Z");
const TOP = "keeta_topwallet000000000000000000000000000000";
const MID = "keeta_midwallet000000000000000000000000000000";
const LOW = "keeta_lowwallet000000000000000000000000000000";
const HELD = BRIDGE;
const INTAKE = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const SINK = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const UNIT = 1_000_000_000_000n;
const SKIP_LOG = new Set(["Close accrue on", "Close accrue off"]);

let passed = 0;
function show(value) {
  return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));
}

function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function md5(text) {
  return createHash("md5").update(text).digest("hex");
}

function pendingTotal(share) {
  let sum = 0n;
  for (const amount of share.pending.values()) sum += amount;
  return sum;
}

function kore6(units) {
  const value = units < 0n ? -units : units;
  const whole = value / UNIT;
  const frac = (value % UNIT).toString().padStart(12, "0").slice(0, 6);
  return `${units < 0n ? "-" : ""}${whole.toString()}.${frac}`;
}

function cloneBooks(books) {
  return booksFromJson(JSON.parse(JSON.stringify(booksToJson(books))));
}

function withStake(when) {
  const books = createBooks(when, fromKta("2"));
  deposit(books.share, TOP, fromKta("60"), when);
  deposit(books.share, MID, fromKta("30"), when);
  deposit(books.share, LOW, fromKta("10"), when);
  deposit(books.share, HELD, fromKta("10"), when);
  return books;
}

function freshBooks() {
  return withStake(LAST);
}

function morningBooks() {
  const books = withStake(dayStart(LAST));
  accrue(books.share, LAST);
  return books;
}

function historyRow({ hash, timeMs, from = null, amount = 0n, external = "" }) {
  const blocks = [];
  if (from) {
    blocks.push({
      account: from,
      hash: `${hash}-b`,
      operations: [{ type: 0, to: INTAKE, token: "base", amount, external }],
    });
  }
  return {
    voteStaple: {
      timestamp: () => new Date(timeMs),
      blocksHash: { toString: () => hash },
      blocks,
    },
  };
}

function bridgeRow(hash, timeMs) {
  return historyRow({ hash, timeMs, from: HELD, amount: 1n, external: `0x${"ab".repeat(32)}` });
}

function creditLines(logs) {
  return logs.filter((line) => line.startsWith("Close credit to "));
}

// fix/rate-hold: the config line gained the hard-limit and last-hour sentences; compare without them.
// fix/rate-hold: state.json gained the rolling-hour list "recent"; compare without it.
function noRecent(st) {
  const copy = { ...st };
  delete copy.recent;
  return copy;
}

function keptLogs(logs) {
  return logs.filter((line) => !SKIP_LOG.has(line)).map((line) => line.replace(/ Hard limits .*? KTA a day\.( Last hour \d+ ledger blocks\.)?/, ""));
}

function loadBooks(dir) {
  return booksFromJson(JSON.parse(readFileSync(join(dir, "books.json"), "utf8")));
}

function loadState(dir) {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error("no network");
};

const archive = mkdtempSync(join(tmpdir(), "cbc28de-src-"));
const tar = execFileSync("git", ["archive", "cbc28dee3424a072b234de8a030b36fc3fb79e1f"], { cwd: "/workspace/fee-cap" });
mkdirSync(archive, { recursive: true });
writeFileSync(join(archive, "src.tar"), tar);
execFileSync("tar", ["-x", "-f", join(archive, "src.tar"), "-C", archive]);
const old = await import(pathToFileURL(join(archive, "run.mjs")).href);
const oldRun = old.runShaft;

function openShaft(books, state = {}, { send = true, payoutQuote, koreBal = 20_000_000n } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ca-"));
  const body = JSON.stringify(booksToJson(books));
  writeFileSync(join(dir, "books.json"), body);
  if (send) writeFileSync(join(dir, "SEND"), "on\n");
  const saved = {
    windowStart: Date.parse("2026-10-20T12:00:00.000Z"),
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "",
    done: [],
    closeOpen: false,
    lastPublishMs: 0,
    payoutFeeDay: "2026-10-20",
    payoutFeeSpent: "0",
    ...state,
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(saved));
  const client = makeClient(booksFromJson(JSON.parse(body)), {
    baseBal: accounted(books),
    koreBal,
    payoutQuote,
  });
  client.send = () => { throw new Error("client.send"); };
  client.getHistory = async () => [];
  const orig = client.publishBuilder.bind(client);
  client.publishBuilder = async (builder, options) => {
    const kore = builder.ops?.find((op) => op.token?.id === "kore");
    const result = await orig(builder, options);
    const last = client.publishes[client.publishes.length - 1];
    if (last && kore) last.key = kore.key;
    return result;
  };
  return { dir, client };
}

async function capture(fn) {
  const logs = [];
  const errors = [];
  const say = console.log;
  const yell = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  try {
    await fn();
  } finally {
    console.log = say;
    console.error = yell;
  }
  return { logs, errors };
}

async function step(ctx, at, { run = runShaft, history = null, balance = null, prep = null } = {}) {
  if (history) ctx.client.getHistory = async () => history;
  if (balance !== null) ctx.client.baseBal = balance;
  if (prep) prep(ctx);
  const beforePubs = ctx.client.publishes.length;
  const time = { t: at };
  const sleeps = [];
  const { logs, errors } = await capture(() => run({
    dir: ctx.dir,
    client: ctx.client,
    base: { id: "base" },
    baseText: "base",
    dustAccount: { id: "dust" },
    koreAccount: { id: "kore" },
    accountFrom: () => ({ id: "dest" }),
    now: () => time.t,
    sleep: async (ms) => { sleeps.push(ms); },
    steps: 1,
  }));
  return {
    logs,
    errors,
    sleeps,
    books: loadBooks(ctx.dir),
    booksText: readFileSync(join(ctx.dir, "books.json"), "utf8"),
    state: loadState(ctx.dir),
    pubs: ctx.client.publishes.slice(beforePubs),
  };
}

async function play(ctx, times, { run = runShaft, historyFor = null, onBetween = null } = {}) {
  const time = { t: times[0] };
  let index = 0;
  if (historyFor) ctx.client.getHistory = async () => historyFor(time.t, index) ?? [];
  const sleeps = [];
  const marks = [];
  const { logs, errors } = await capture(() => run({
    dir: ctx.dir,
    client: ctx.client,
    base: { id: "base" },
    baseText: "base",
    dustAccount: { id: "dust" },
    koreAccount: { id: "kore" },
    accountFrom: () => ({ id: "dest" }),
    now: () => time.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      marks.push({
        at: time.t,
        closeOpen: loadState(ctx.dir).closeOpen,
        lastMs: loadBooks(ctx.dir).share.lastMs,
        pubs: ctx.client.publishes.length,
      });
      index += 1;
      if (index < times.length) time.t = times[index];
      if (onBetween) onBetween({ index, time, ctx });
      if (historyFor) ctx.client.getHistory = async () => historyFor(time.t, index) ?? [];
    },
    steps: times.length,
  }));
  return { logs, errors, sleeps, marks, books: loadBooks(ctx.dir), state: loadState(ctx.dir) };
}

function payOrder(books) {
  const share = cloneBooks(books).share;
  const skip = [];
  const rows = [];
  for (;;) {
    const next = choosePayout(share, { intake: INTAKE, sink: SINK, skip });
    if (!next) break;
    rows.push(next);
    skip.push(next.from);
  }
  return rows;
}

function who(pub) {
  const matched = String(pub.key || "").match(/^kore-(.+)-(\d+)$/);
  return matched ? matched[1] : "";
}

const savedEnv = {
  CLOSE_ACCRUE: process.env.CLOSE_ACCRUE,
  PICKS_OFF: process.env.PICKS_OFF,
};
process.env.PICKS_OFF = "1";
process.env.CLOSE_ACCRUE = "1";

try {
  const opened = freshBooks();
  const expectedNow = cloneBooks(opened);
  accrue(expectedNow.share, EDGE);
  const expectedCredit = pendingTotal(expectedNow.share) - pendingTotal(opened.share);
  const expectedRows = payOrder(expectedNow);
  check("fixture has three paying wallets", expectedRows.length === 3 && expectedRows[0].from === TOP, expectedRows.map((row) => `${row.from}:${row.amount}`).join(","));
  check("top wallet's stuck-day due is the largest", expectedRows[0].amount > expectedRows[1].amount && expectedRows[0].amount > 0n);

  const main = openShaft(opened);
  const night = await step(main, T2358);
  check("23:58 does not credit", creditLines(night.logs).length === 0 && night.books.share.lastMs === LAST, night.logs.filter((line) => line.includes("credit") || line.startsWith("Close")).join("\n"));
  check("23:58 does not pay", night.pubs.length === 0 && night.state.closeOpen === false && night.state.payoutDay === "2026-10-20", show(night.pubs));
  check("23:58 waits for the next close", night.logs.includes("Payouts wait for the next close."));

  const grace = await step(main, T0030);
  check("grace: 00:00:30 does not credit", creditLines(grace.logs).length === 0 && grace.books.share.lastMs === LAST, creditLines(grace.logs).join("\n"));
  check("grace: close stays shut and nothing is published", grace.pubs.length === 0 && grace.state.closeOpen === false && !grace.logs.includes("Close. One send per wallet."), grace.logs.filter((line) => line.startsWith("Close") || line.startsWith("Paid") || line.startsWith("Payout")).join("\n"));

  const beforePending = pendingTotal(grace.books.share);
  const credited = await step(main, T0201);
  const grew = pendingTotal(credited.books.share) - beforePending;
  check("00:02:01 credits exactly share.mjs accrue for [lastMs, edge)", grew === expectedCredit && credited.books.share.lastMs === EDGE, `${grew} vs ${expectedCredit} last ${credited.books.share.lastMs}`);
  const creditLog = creditLines(credited.logs);
  check("credit log names the edge and 6 decimals", creditLog.length === 1 && creditLog[0] === `Close credit to ${new Date(EDGE).toISOString()}. KORE ${kore6(expectedCredit)}.`, creditLog.join("\n"));
  check("close opens and the largest wallet is paid first", credited.logs.includes("Close. One send per wallet.") && credited.pubs.length === 1 && who(credited.pubs[0]) === TOP && credited.pubs[0].amount === expectedRows[0].amount, show(credited.pubs));
  check("startup says close accrue is on", credited.logs.includes("Close accrue on"));

  const paid = new Map([[who(credited.pubs[0]), credited.pubs[0].amount]]);
  let cursor = T0201;
  for (let n = 1; n < expectedRows.length; n += 1) {
    cursor += 61_000;
    const again = await step(main, cursor);
    check(`restart ${n} does not credit again`, creditLines(again.logs).length === 0 && again.books.share.lastMs === EDGE, creditLines(again.logs).join("\n") || String(again.books.share.lastMs));
    check(`restart ${n} pays the next wallet`, again.pubs.length === 1 && who(again.pubs[0]) === expectedRows[n].from && again.pubs[0].amount === expectedRows[n].amount, show(again.pubs));
    paid.set(who(again.pubs[0]), again.pubs[0].amount);
  }
  for (const row of expectedRows) {
    check(`paid ${row.from} equals full due`, paid.get(row.from) === row.amount && loadBooks(main.dir).share.paid.get(row.from) === row.amount, `${paid.get(row.from)} vs ${row.amount}`);
  }
  check("held wallet is not auto-paid", !paid.has(HELD) && (loadBooks(main.dir).share.paid.get(HELD) ?? 0n) === 0n);
  const done = await step(main, cursor + 61_000);
  check("close finishes with no further credit", done.logs.includes("Close paid.") && done.state.closeOpen === false && creditLines(done.logs).length === 0 && done.pubs.length === 0, done.logs.filter((line) => line.startsWith("Close")).join("\n"));

  const hour = EDGE + 3_600_000;
  const beforeHour = pendingTotal(loadBooks(main.dir).share);
  const stapled = await step(main, hour + 5_000, { history: [historyRow({ hash: "hour-staple", timeMs: hour })] });
  const probe = cloneBooks(done.books);
  const probeBefore = pendingTotal(probe.share);
  accrue(probe.share, hour);
  const hourPot = (dayBudget(EDGE) * UNIT * 3_600_000n) / BigInt(DAY_MS);
  check("later staple credits only from the edge at the next day's budget", pendingTotal(stapled.books.share) - beforeHour === pendingTotal(probe.share) - probeBefore && pendingTotal(stapled.books.share) - beforeHour === hourPot && stapled.books.share.lastMs === hour, `${pendingTotal(stapled.books.share) - beforeHour} vs ${hourPot}`);
  check("later staple is not a second close credit", creditLines(stapled.logs).length === 0 && !stapled.errors.some((line) => line.includes("time moved backwards")), stapled.errors.join("\n"));
  const afterEdge = await step(main, hour + 70_000, { history: [] });
  check("later staple does not credit or throw", creditLines(afterEdge.logs).length === 0 && afterEdge.books.share.lastMs === hour && !afterEdge.errors.some((line) => line.includes("time moved backwards")), afterEdge.errors.join("\n"));

  const late = openShaft(freshBooks(), { payoutDay: "2026-10-20" });
  const lateAt = Date.parse("2026-10-20T23:59:50.000Z");
  const lateTick = await step(late, T0100, { history: [historyRow({ hash: "late-grace", timeMs: lateAt })] });
  const lateExpected = cloneBooks(freshBooks());
  accrue(lateExpected.share, lateAt);
  check("grace staple at 23:59:50 is ingested once", lateTick.books.share.lastMs === lateAt && pendingTotal(lateTick.books.share) === pendingTotal(lateExpected.share) && lateTick.books.recent.includes("late-grace"), String(lateTick.books.share.lastMs));
  check("grace staple does not open the close", creditLines(lateTick.logs).length === 0 && lateTick.pubs.length === 0 && lateTick.state.closeOpen === false);
  const rest = await step(late, T0201);
  const stepped = cloneBooks(freshBooks());
  accrue(stepped.share, lateAt);
  const afterStaple = pendingTotal(stepped.share);
  accrue(stepped.share, EDGE);
  const restOnly = pendingTotal(stepped.share) - afterStaple;
  const added = pendingTotal(rest.books.share) - pendingTotal(lateTick.books.share);
  check("close credit after the grace staple adds only the remaining slice", added === restOnly && pendingTotal(rest.books.share) === pendingTotal(stepped.share) && rest.books.share.lastMs === EDGE && creditLines(rest.logs).length === 1, `${added} vs ${restOnly}`);

  const after = openShaft(freshBooks());
  await step(after, T0201);
  const oldStaple = await step(after, T0300, { history: [historyRow({ hash: "late-after", timeMs: lateAt })] });
  check("staple timestamped before the edge arrives at lastMs", oldStaple.books.share.lastMs === EDGE && oldStaple.books.recent.includes("late-after") && creditLines(oldStaple.logs).length === 0, String(oldStaple.books.share.lastMs));
  check("late staple does not throw time moved backwards", !oldStaple.errors.some((line) => line.includes("time moved backwards")), oldStaple.errors.join("\n"));
  const once = cloneBooks(freshBooks());
  accrue(once.share, EDGE);
  check("no double credit from the late staple", pendingTotal(oldStaple.books.share) === pendingTotal(once.share));

  async function gated(name, prepFirst, prepClear) {
    const ctx = openShaft(freshBooks(), { payoutDay: "2026-10-20" });
    prepFirst(ctx);
    const blocked = await step(ctx, T0201);
    check(`${name} does not credit or open`, creditLines(blocked.logs).length === 0 && blocked.books.share.lastMs === LAST && blocked.state.closeOpen === false && blocked.pubs.length === 0 && !blocked.logs.includes("Close. One send per wallet."), [...blocked.logs, ...blocked.errors].filter((line) => line.startsWith("Close") || line.startsWith("Paid") || line.startsWith("KORE")).join("\n"));
    prepClear(ctx);
    const opened = await step(ctx, T0201 + 61_000);
    check(`${name} credits once when it clears`, creditLines(opened.logs).length === 1 && opened.books.share.lastMs === EDGE && opened.logs.includes("Close. One send per wallet.") && opened.pubs.length === 1, creditLines(opened.logs).join("\n"));
    return ctx;
  }

  await gated("PAYHOLD", (ctx) => writeFileSync(join(ctx.dir, "PAYHOLD"), "hold\n"), (ctx) => unlinkSync(join(ctx.dir, "PAYHOLD")));
  await gated(
    "payout intent",
    (ctx) => writeFileSync(join(ctx.dir, "payout-intent.json"), JSON.stringify({ from: TOP, amount: "1", key: `kore-${TOP}-1`, floor: "0" })),
    (ctx) => {
      unlinkSync(join(ctx.dir, "payout-intent.json"));
      if (existsSync(join(ctx.dir, "PAYHOLD"))) unlinkSync(join(ctx.dir, "PAYHOLD"));
    },
  );

  const burnDrop = fromKta("0.5");
  const waitingBooks = freshBooks();
  waitingBooks.pendingDrops = [burnDrop];
  waitingBooks.pendingSince = T0201;
  const waiting = openShaft(waitingBooks, { payoutDay: "2026-10-20" });
  waiting.client.baseBal = accounted(waitingBooks) - burnDrop;
  const waitingTick = await step(waiting, T0201);
  check("waiting-burn does not credit or open", waitingTick.logs.some((line) => line.startsWith("Books waiting-burn")) && creditLines(waitingTick.logs).length === 0 && waitingTick.state.closeOpen === false && waitingTick.books.share.lastMs === LAST, waitingTick.logs.filter((line) => line.startsWith("Books") || line.startsWith("Close")).join("\n"));
  const clearedBurn = await step(waiting, T0201 + 121_000);
  check("waiting-burn credits once after the burn clears", clearedBurn.logs.some((line) => line.startsWith("Books waiting-burn")) === false && creditLines(clearedBurn.logs).length === 1 && clearedBurn.books.share.lastMs === EDGE && clearedBurn.pubs.length === 1, [...creditLines(clearedBurn.logs), ...clearedBurn.logs.filter((line) => line.startsWith("Books"))].join("\n"));

  const missing = openShaft(freshBooks(), { payoutDay: "2026-10-20" });
  const high = accounted(freshBooks()) + fromKta("1");
  missing.client.baseBal = high;
  const missingTimes = [T0201, T0201 + 29_000, T0201 + 90_000, T0201 + 180_000];
  const missingRun = await play(missing, missingTimes, {
    onBetween: ({ index }) => {
      missing.client.baseBal = index === missingTimes.length - 1 ? accounted(freshBooks()) : high;
    },
  });
  const waitLogs = missingRun.logs.filter((line) => line.startsWith("Close credit waits."));
  check("missing-deposit waits and does not credit", waitLogs[0] === "Close credit waits. Books missing-deposit." && missingRun.books.share.lastMs === EDGE, waitLogs.join("\n"));
  check("missing-deposit wait log is at most once a minute", waitLogs.length === 2, waitLogs.join("\n"));
  check("missing-deposit credits once after it clears", creditLines(missingRun.logs).length === 1 && missingRun.books.share.lastMs === EDGE && missing.client.publishes.length === 1, creditLines(missingRun.logs).join("\n"));

  const retryTimes = [T0201, T0201 + 19_000, T0201 + 120_000, T0201 + 200_000];
  const retry = openShaft(freshBooks(), { payoutDay: "2026-10-20" });
  const retryRun = await play(retry, retryTimes, {
    historyFor: (at, index) => (index < retryTimes.length - 1 ? [bridgeRow("bridge-retry", at)] : []),
  });
  const retryWaits = retryRun.logs.filter((line) => line.startsWith("Close credit waits."));
  check("chainRetry waits without crediting", retryWaits[0] === "Close credit waits. Books ok." && retryWaits.length === 2 && creditLines(retryRun.logs).length === 1 && retryRun.books.share.lastMs === EDGE, retryWaits.join("\n"));
  check("chainRetry does not publish while it waits", retryRun.marks.slice(0, 3).every((mark) => mark.pubs === 0 && mark.closeOpen === false), show(retryRun.marks));
  check("fetch was stubbed for the bridge retry", fetchCalls > 0);

  function giveUpTimes() {
    return [
      T0030,
      T0201,
      Date.parse("2026-10-21T00:29:59.000Z"),
      T3001,
      Date.parse("2026-10-21T00:32:00.000Z"),
    ];
  }

  async function giveUp(name, tune) {
    const books = morningBooks();
    const owed = payOrder(books).map((row) => ({ from: row.from, amount: row.amount }));
    const ctx = openShaft(books, { payoutDay: "2026-10-20" });
    tune(ctx, books);
    const times = giveUpTimes();
    let snap = null;
    const ran = await play(ctx, times, {
      onBetween: ({ index }) => {
        if (index === 3 && !snap) {
          snap = {
            books: readFileSync(join(ctx.dir, "books.json"), "utf8"),
            state: readFileSync(join(ctx.dir, "state.json"), "utf8"),
          };
        }
      },
    });
    const skipped = ran.logs.filter((line) => line === "Close credit skipped. Normal close.");
    check(`${name} stays shut before 00:30`, ran.marks.slice(0, 3).every((mark) => mark.closeOpen === false && mark.pubs === 0 && mark.lastMs === LAST) && creditLines(ran.logs).length === 0, show(ran.marks));
    check(`${name} gives up once at 00:30:01 and pays`, skipped.length === 1 && ctx.client.publishes.length >= 1 && ctx.client.publishes[0].amount === owed[0].amount && ran.logs.includes("Close. One send per wallet."), `${skipped.join("\n")}\n${show(ctx.client.publishes.slice(0, 2))}`);
    check(`${name} never credits the stuck day`, ran.books.share.pending.get(TOP) === books.share.pending.get(TOP), `${ran.books.share.pending.get(TOP)} vs ${books.share.pending.get(TOP)}`);
    check(`${name} snapshot is still the pre-close books`, Boolean(snap) && booksFromJson(JSON.parse(snap.books)).share.lastMs === LAST, snap ? String(booksFromJson(JSON.parse(snap.books)).share.lastMs) : "no snap");
    const preBooks = JSON.parse(snap.books);
    const preState = JSON.parse(snap.state);
    const oursLeft = openShaft(booksFromJson(JSON.parse(snap.books)), preState);
    const baseLeft = openShaft(booksFromJson(JSON.parse(snap.books)), preState);
    writeFileSync(join(oursLeft.dir, "books.json"), snap.books);
    writeFileSync(join(baseLeft.dir, "books.json"), snap.books);
    tune(oursLeft, booksFromJson(JSON.parse(snap.books)));
    tune(baseLeft, booksFromJson(JSON.parse(snap.books)));
    const postTimes = [T3001, Date.parse("2026-10-21T00:32:00.000Z")];
    const ours = [];
    const base = [];
    for (const at of postTimes) {
      ours.push(await step(oursLeft, at, { run: runShaft }));
      base.push(await step(baseLeft, at, { run: oldRun }));
    }
    const oursLogs = ours.map((item) => keptLogs(item.logs).filter((line) => line !== "Close credit skipped. Normal close."));
    const baseLogs = base.map((item) => keptLogs(item.logs));
    check(`${name} matches cbc28de books after give-up`, ours.at(-1).booksText === base.at(-1).booksText, "books diverged");
    check(`${name} matches cbc28de payouts after give-up`, show(ours.flatMap((item) => item.pubs)) === show(base.flatMap((item) => item.pubs)), show({ ours: ours.flatMap((item) => item.pubs), base: base.flatMap((item) => item.pubs) }));
    check(`${name} matches cbc28de logs after the new lines`, JSON.stringify(oursLogs) === JSON.stringify(baseLogs), oursLogs.flat().filter((line, i) => line !== baseLogs.flat()[i]).slice(0, 12).join("\n"));
    void preBooks;
    return ran;
  }

  await giveUp("missing-deposit", (ctx) => {
    ctx.client.baseBal = accounted(morningBooks()) + fromKta("1");
  });
  await giveUp("chainRetry", (ctx) => {
    ctx.client.getHistory = async () => [bridgeRow("bridge-giveup", LAST)];
  });

  const flagTimes = [T2358, T0030, T0201];
  async function flagScenario(run, accrueFlag) {
    const prev = process.env.CLOSE_ACCRUE;
    if (accrueFlag === undefined) delete process.env.CLOSE_ACCRUE;
    else process.env.CLOSE_ACCRUE = accrueFlag;
    const ctx = openShaft(morningBooks());
    const ticks = [];
    try {
      for (const at of flagTimes) ticks.push(await step(ctx, at, { run }));
    } finally {
      if (prev === undefined) delete process.env.CLOSE_ACCRUE;
      else process.env.CLOSE_ACCRUE = prev;
    }
    return { ticks, ctx };
  }
  const baseline = await flagScenario(oldRun, undefined);
  for (const flag of [undefined, "0", "true"]) {
    const label = flag === undefined ? "unset" : JSON.stringify(flag);
    const ran = await flagScenario(runShaft, flag);
    check(`flag ${label} books match cbc28de`, ran.ticks.at(-1).booksText === baseline.ticks.at(-1).booksText);
    check(`flag ${label} payouts match cbc28de`, show(ran.ticks.map((tick) => tick.pubs)) === show(baseline.ticks.map((tick) => tick.pubs)), show(ran.ticks.map((tick) => tick.pubs)));
    check(`flag ${label} logs match cbc28de except the off line`, JSON.stringify(ran.ticks.map((tick) => keptLogs(tick.logs))) === JSON.stringify(baseline.ticks.map((tick) => keptLogs(tick.logs))));
    // fix/rate-hold: the publish gap is 120 s (was 60 s), so a tick may hold extra rate waits of at most 60 s each.
    const extraOk = ran.ticks.every((tick, i) => {
      const left = [...tick.sleeps];
      for (const ms of baseline.ticks[i].sleeps) {
        const at = left.indexOf(ms);
        if (at < 0) return false;
        left.splice(at, 1);
      }
      return left.every((ms) => ms > 0 && ms <= 60_000);
    });
    // fix/rate-hold r2 (Ops): the extra waits are only the gap, at most 60 s per publish, and the saved
    // rolling count is exactly 2 ledger blocks (work + fee) per publish in this run (all within one hour).
    const pubCount = ran.ticks.reduce((sum, tick) => sum + tick.pubs.length, 0);
    const extraMs = ran.ticks.reduce((sum, tick, i) => sum + tick.sleeps.reduce((a, b) => a + b, 0) - baseline.ticks[i].sleeps.reduce((a, b) => a + b, 0), 0);
    const counted = (ran.ticks.at(-1).state.recent ?? []).reduce((sum, item) => sum + item[1], 0);
    check(`flag ${label} sleeps match cbc28de except the 120 s gap, and state matches`, extraOk && JSON.stringify(noRecent(ran.ticks.at(-1).state)) === JSON.stringify(baseline.ticks.at(-1).state), JSON.stringify(ran.ticks.map((tick) => tick.sleeps)));
    check(`flag ${label} block counter is 2 x publishes (${pubCount}) and extra waits are under 60 s a publish`, pubCount >= 1 && counted === 2 * pubCount && extraMs >= 0 && extraMs <= 60_000 * pubCount, `counted ${counted} pubs ${pubCount} extra ${extraMs}`);
    check(`flag ${label} prints close accrue off and does not credit`, ran.ticks.every((tick) => tick.logs.includes("Close accrue off") && creditLines(tick.logs).length === 0));
  }
  check("cbc28de copy has no close-accrue startup line", baseline.ticks.every((tick) => !tick.logs.some((line) => line.startsWith("Close accrue"))));

  async function refusal(name, tune) {
    const books = morningBooks();
    const prev = process.env.CLOSE_ACCRUE;
    process.env.CLOSE_ACCRUE = "1";
    const ours = openShaft(books, tune.state || { payoutDay: "2026-10-20" }, { payoutQuote: tune.quote });
    const base = openShaft(books, tune.state || { payoutDay: "2026-10-20" }, { payoutQuote: tune.quote });
    const startSpent = (tune.state || {}).payoutFeeSpent || "0";
    const startBal = ours.client.baseBal;
    try {
      const a = await step(ours, T0201);
      const b = await step(base, T0201, { run: oldRun });
      const alerts = (errors) => errors.filter((line) => line.startsWith("ALERT"));
      check(`${name} refuses like cbc28de`, JSON.stringify(alerts(a.errors)) === JSON.stringify(alerts(b.errors)) && alerts(a.errors).length === 1, alerts(a.errors).join("\n") + " || " + alerts(b.errors).join("\n"));
      check(`${name} spends nothing`, a.pubs.length === 0 && b.pubs.length === 0 && a.state.payoutFeeSpent === startSpent && ours.client.baseBal === startBal && b.state.payoutFeeSpent === startSpent, `${a.state.payoutFeeSpent} pubs ${a.pubs.length}`);
      check(`${name} still credited the day before the refusal`, a.books.share.lastMs === EDGE && b.books.share.lastMs === LAST);
    } finally {
      if (prev === undefined) delete process.env.CLOSE_ACCRUE;
      else process.env.CLOSE_ACCRUE = prev;
    }
  }
  await refusal("fee over the 0.05 cap", { quote: fromKta("0.06"), state: { payoutDay: "2026-10-20" } });
  await refusal("day fee budget used up", {
    quote: fromKta("0.00404"),
    state: { payoutDay: "2026-10-20", payoutFeeDay: "2026-10-21", payoutFeeSpent: payoutFeeBudget().toString() },
  });

  const quiet = openShaft(freshBooks(), {}, { send: false });
  const quietStapleAt = Date.parse("2026-10-21T00:05:00.000Z");
  const quietTick = await step(quiet, quietStapleAt, { history: [historyRow({ hash: "backfill", timeMs: quietStapleAt })] });
  const backfill = cloneBooks(freshBooks());
  accrue(backfill.share, quietStapleAt);
  check("send off does not close-credit", creditLines(quietTick.logs).length === 0 && quietTick.pubs.length === 0 && !quietTick.logs.includes("Close. One send per wallet."));
  check("send off lets the next staple backfill from the stuck lastMs", quietTick.books.share.lastMs === quietStapleAt && pendingTotal(quietTick.books.share) === pendingTotal(backfill.share), `${quietTick.books.share.lastMs} ${pendingTotal(quietTick.books.share)} vs ${pendingTotal(backfill.share)}`);
  const quietBase = openShaft(freshBooks(), {}, { send: false });
  const quietOld = await step(quietBase, quietStapleAt, { run: oldRun, history: [historyRow({ hash: "backfill", timeMs: quietStapleAt })] });
  check("send off books match cbc28de", keptLogs(quietTick.logs).join("\n") === keptLogs(quietOld.logs).join("\n") && quietTick.booksText === quietOld.booksText);

  const dryBooks = freshBooks();
  const dryPath = join(main.dir, "dry-books.json");
  const dryBody = JSON.stringify(booksToJson(dryBooks));
  writeFileSync(dryPath, dryBody);
  const dryStat = statSync(dryPath);
  const dry = spawnSync(process.execPath, ["close-accrue-dry.mjs", dryPath, new Date(EDGE).toISOString()], {
    cwd: "/workspace/fee-cap",
    encoding: "utf8",
  });
  const dryAfter = statSync(dryPath);
  check("dry script leaves books md5 and mtime unchanged", dry.status === 0 && md5(readFileSync(dryPath)) === md5(dryBody) && dryAfter.mtimeMs === dryStat.mtimeMs && readFileSync(dryPath, "utf8") === dryBody, dry.stderr || dry.stdout);
  const dryLines = dry.stdout.trim().split("\n");
  check("dry script prints the close and the wallet count", dryLines[0].startsWith("CLOSE_DRY ") && dryLines[1] === `LASTMS ${new Date(LAST).toISOString()}` && dryLines[2] === `EDGE ${new Date(EDGE).toISOString()}` && dryLines.at(-1) === "CLOSE_DRY_OK", dry.stdout);
  const dueLine = dryLines.find((line) => line.startsWith("TOTAL_DUE_AT_CLOSE "));
  const creditLine = dryLines.find((line) => line.startsWith("TOTAL_CREDIT "));
  const walletLine = dryLines.find((line) => line.startsWith("WALLETS "));
  const paidSum = expectedRows.reduce((sum, row) => sum + row.amount, 0n);
  check("dry totals match test 3 payouts", dueLine === `TOTAL_DUE_AT_CLOSE ${paidSum}` && creditLine === `TOTAL_CREDIT ${kore6(expectedCredit)}` && walletLine === `WALLETS ${expectedRows.length}`, dry.stdout);
  const walletLines = dryLines.filter((line) => /^\d+ keeta_/.test(line));
  for (const row of expectedRows) {
    const line = walletLines.find((item) => item.includes(` ${row.from} `));
    check(`dry line for ${row.from} matches the payout`, Boolean(line) && line.endsWith(`due ${row.amount}`), line || dry.stdout);
  }
  const drySource = readFileSync("/workspace/fee-cap/close-accrue-dry.mjs", "utf8");
  check("dry script does not import run.mjs", !/from\s+["']\.\/run\.mjs["']/.test(drySource) && !dry.stdout.includes("Runner up"));
  const heldLine = dryLines.find((line) => line.startsWith("HELD "));
  check("dry script names the held address", heldLine === `HELD ${HELD} ${due(expectedNow.share, HELD)}`, heldLine || "");
  const nothingPath = join(main.dir, "nothing.json");
  const nothing = cloneBooks(freshBooks());
  nothing.share.lastMs = EDGE + 1;
  const nothingBody = JSON.stringify(booksToJson(nothing));
  writeFileSync(nothingPath, nothingBody);
  const nothingRun = spawnSync(process.execPath, ["close-accrue-dry.mjs", nothingPath, new Date(EDGE).toISOString()], { cwd: "/workspace/fee-cap", encoding: "utf8" });
  check("dry script prints NOTHING_TO_CREDIT when lastMs is past the edge", nothingRun.status === 0 && nothingRun.stdout.includes("NOTHING_TO_CREDIT") && nothingRun.stdout.trim().endsWith("CLOSE_DRY_OK") && readFileSync(nothingPath, "utf8") === nothingBody, nothingRun.stdout);
  const bad = spawnSync(process.execPath, ["close-accrue-dry.mjs", join(main.dir, "missing-books.json")], { cwd: "/workspace/fee-cap", encoding: "utf8" });
  check("dry script fails with the error name only", bad.status === 1 && bad.stdout.trim() === "CLOSE_DRY_FAIL Error" && !bad.stdout.includes("/") && !bad.stderr.includes("missing-books"), bad.stdout + bad.stderr);

  const post = openShaft(freshBooks(), { payoutDay: "2026-10-20" });
  const posted = await step(post, T0201);
  check("post-credit lastMs is the edge", posted.books.share.lastMs === EDGE && !posted.errors.some((line) => line.includes("time moved backwards")));
  const postText = readFileSync(join(post.dir, "books.json"), "utf8");
  const postState = loadState(post.dir);
  const cont = openShaft(booksFromJson(JSON.parse(postText)), postState);
  const contOld = openShaft(booksFromJson(JSON.parse(postText)), postState);
  cont.client.koreBal = post.client.koreBal;
  contOld.client.koreBal = post.client.koreBal;
  const olderAt = Date.parse("2026-10-21T00:10:00.000Z");
  const olderHistory = [historyRow({ hash: "older-than-edge", timeMs: lateAt })];
  const older = await step(cont, olderAt, { history: olderHistory });
  const olderBase = await step(contOld, olderAt, { run: oldRun, history: olderHistory });
  check("older staple does not move time backwards", older.books.share.lastMs === EDGE && older.books.recent.includes("older-than-edge") && !older.errors.some((line) => line.includes("time moved backwards")) && older.booksText === olderBase.booksText, older.errors.join("\n"));
  const short = fromKta("0.01");
  const shortBal = accounted(older.books) - short;
  const shortTick = await step(cont, olderAt + 61_000, { balance: shortBal, history: [] });
  const shortBase = await step(contOld, olderAt + 61_000, { run: oldRun, balance: shortBal, history: [] });
  check("burn shortfall matches cbc28de and does not throw", shortTick.booksText === shortBase.booksText && !shortTick.errors.some((line) => line.includes("time moved backwards")) && !shortBase.errors.some((line) => line.includes("time moved backwards")), shortTick.errors.join("\n"));
  check("shortfall tick stays on the ok path", !shortTick.logs.some((line) => line.startsWith("Books ")) && shortTick.books.share.lastMs >= EDGE);

  check("client.send and client.recover were never used", [main, late, after, waiting, missing, retry, quiet, post, cont].every((ctx) => ctx.client.recoverCalls === 0));
  check("dry script source never imports run.mjs", !/from\s+["']\.\/run\.mjs["']/.test(drySource));

  console.log(`close-accrue-check ok ${passed}`);
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  if (savedEnv.CLOSE_ACCRUE === undefined) delete process.env.CLOSE_ACCRUE;
  else process.env.CLOSE_ACCRUE = savedEnv.CLOSE_ACCRUE;
  if (savedEnv.PICKS_OFF === undefined) delete process.env.PICKS_OFF;
  else process.env.PICKS_OFF = savedEnv.PICKS_OFF;
  rmSync(archive, { recursive: true, force: true });
}
