import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { booksToJson, createBooks, ingest } from "./books.mjs";
import { startMs } from "./ledger.mjs";
import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { makeClient } from "./fee-harness.mjs";
import { runShaft } from "./run.mjs";

const say = console.log;
const yell = console.error;
let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  say("ok", name);
}

const intake = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const sink = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const hour = 3_600_000;
const open = Date.parse("2026-10-18T15:00:00.000Z");

function id(value) {
  return { publicKeyString: { toString: () => value } };
}

function healHistory(time) {
  let n = 0;
  return async () => {
    n += 1;
    return [{
      voteStaple: {
        blocksHash: { toString: () => `heal-${time.t}-${n}` },
        timestamp: () => new Date(time.t),
        blocks: [{
          account: id(intake),
          operations: [{ type: 0, to: id(sink), token: id("base"), amount: 1n }],
        }],
      },
    }];
  };
}

function stamp(client, time) {
  const orig = client.publishBuilder.bind(client);
  client.publishBuilder = async (...args) => {
    const at = time.t;
    const before = client.publishes.length;
    const result = await orig(...args);
    if (client.publishes.length > before) client.publishes[client.publishes.length - 1].at = at;
    return result;
  };
}

async function runHour({ books, client, steps, send = false, state = null, prepare = null }) {
  const dir = mkdtempSync(join(tmpdir(), "kore-site-rate-"));
  writeFileSync(join(dir, "books.json"), JSON.stringify(booksToJson(books)));
  if (send) writeFileSync(join(dir, "SEND"), "on\n");
  if (state) writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  const time = { t: open };
  if (prepare) prepare(time);
  console.log = () => {};
  console.error = () => {};
  try {
    await runShaft({
      dir,
      client,
      base: { id: "base" },
      baseText: "base",
      dustAccount: { id: "dust" },
      koreAccount: { id: "kore" },
      accountFrom: () => ({ id: "dest" }),
      now: () => time.t,
      sleep: async (ms) => { time.t += ms; },
      steps,
    });
  } finally {
    console.log = say;
    console.error = yell;
  }
  return client.publishes.filter((row) => row.at < open + hour);
}

function crowd(count) {
  const books = createBooks(startMs, fromKta("10"));
  const deposits = [];
  for (let i = 0; i < count; i += 1) {
    deposits.push({ from: `keeta_miner_${String(i).padStart(3, "0")}`, amount: fromKta("1") });
  }
  ingest(books, { blocksHash: "crowd", timeMs: startMs + 1000, deposits, ownPicks: 0 });
  ingest(books, { blocksHash: "crowd-day", timeMs: startMs + 86_400_000 + 1000, deposits: [], ownPicks: 0 });
  return books;
}

async function picks(limit) {
  process.env.MAX_BLOCKS_PER_HOUR = String(limit);
  const books = createBooks(startMs, fromKta("400"));
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const published = await runHour({
    books,
    client,
    steps: limit + 5,
    prepare(time) {
      client.getHistory = healHistory(time);
      stamp(client, time);
    },
  });
  return published.filter((row) => row.kind === "pick");
}

async function payouts(limit, wallets) {
  process.env.MAX_BLOCKS_PER_HOUR = String(limit);
  const books = crowd(wallets);
  const client = makeClient(books, {
    pickQuote: fromKta("0.006"),
    payoutQuote: fromKta("0.00404"),
    voteFee: fromKta("0.00404"),
    koreBal: 1_000_000n,
  });
  const orig = client.initBuilder.bind(client);
  client.initBuilder = () => {
    const builder = orig();
    const compute = builder.computeBlocks.bind(builder);
    builder.computeBlocks = async () => {
      if (builder.ops.some((op) => op.token?.id === "kore")) return compute();
      return { blocks: [] };
    };
    return builder;
  };
  const timeBox = {};
  const published = await runHour({
    books,
    client,
    send: true,
    steps: wallets + 5,
    state: {
      windowStart: open,
      spent: "0",
      feePerTx: FEE_PER_TX.toString(),
      payoutDay: "2026-10-18",
      done: [],
      closeOpen: true,
    },
    prepare(time) {
      timeBox.t = time;
      stamp(client, time);
    },
  });
  return published.filter((row) => row.kind === "payout");
}

// fix/rate-hold: the cap is 60 LEDGER blocks a rolling hour and each publish is 2 blocks (work + fee),
// so a full hour is 30 publishes. 120 in the env is clamped to the hard 60.
const pick60 = await picks(60);
check("60 ledger blocks an hour caps picks at 30 publishes", pick60.length === 30, String(pick60.length));
const pick120 = await picks(120);
check("120 in the env is clamped: still 30 pick publishes", pick120.length === 30, String(pick120.length));
const pay60 = await payouts(60, 70);
check("60 ledger blocks an hour caps payouts at 30 publishes", pay60.length === 30, String(pay60.length));
const pay120 = await payouts(120, 130);
check("120 in the env is clamped: still 30 payout publishes", pay120.length === 30, String(pay120.length));
delete process.env.MAX_BLOCKS_PER_HOUR;
console.log("fee-site-rate checks", passed);
