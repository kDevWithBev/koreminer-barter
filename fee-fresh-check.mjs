import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { makeBooks, makeClient, runCase } from "./fee-harness.mjs";
process.env.PICKS_OFF = "0"; // fix/rate-hold r2: picks run only with PICKS_OFF=0 (missing or empty now means off)

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

const start = Date.parse("2026-10-18T15:00:00.000Z");
// fix/rate-hold: 120 s, since each publish is 2 ledger blocks under the 60 an hour cap.
const gap = 120_000;

function watchQuotes(client, time, marks) {
  const orig = client.getQuotes.bind(client);
  client.getQuotes = async (blocks) => {
    const payout = (blocks ?? []).some((block) => (block.operations ?? []).some((op) => op.token?.id === "kore"));
    marks.push({ kind: payout ? "payout" : "pick", t: time.t });
    return orig(blocks);
  };
}

const pickMarks = [];
const picked = await runCase({
  books: makeBooks(false),
  client: makeClient(makeBooks(false), { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") }),
  steps: 1,
  clock: start,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "",
    done: [],
    closeOpen: false,
    lastPublishMs: start,
  },
  prepare({ client, time }) { watchQuotes(client, time, pickMarks); },
});
check("a pick waits out the rate before the quote", picked.sleeps[0] === gap && pickMarks[0]?.t === start + gap, JSON.stringify({ sleeps: picked.sleeps, marks: pickMarks }));
check("a pick quote is not held across the rate wait", pickMarks[0] && picked.client.publishes.length === 1 && pickMarks[0].t === start + picked.sleeps[0]);

const payMarks = [];
const paid = await runCase({
  books: makeBooks(true),
  client: makeClient(makeBooks(true), { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") }),
  send: true,
  steps: 1,
  clock: start,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
    lastPublishMs: start,
  },
  prepare({ client, time }) { watchQuotes(client, time, payMarks); },
});
check("a payout waits out the rate before the quote", paid.sleeps[0] === gap && payMarks[0]?.kind === "payout" && payMarks[0].t === start + gap, JSON.stringify({ sleeps: paid.sleeps, marks: payMarks }));
check("a payout quote is fresh when it is published", paid.client.publishes.some((row) => row.kind === "payout"));

const recoverMarks = [];
const recovered = await runCase({
  books: makeBooks(false),
  client: makeClient(makeBooks(false), {
    pickQuote: fromKta("0.006"),
    voteFee: fromKta("0.006"),
    pending: { date: new Date(start), blocks: [{ operations: [{ token: { id: "base" } }] }] },
  }),
  steps: 0,
  clock: start,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "",
    done: [],
    closeOpen: false,
    lastPublishMs: start,
  },
  prepare({ client, time }) { watchQuotes(client, time, recoverMarks); },
});
check("a recover waits out the rate before the quote", recovered.sleeps[0] === gap && recoverMarks[0]?.t === start + gap, JSON.stringify({ sleeps: recovered.sleeps, marks: recoverMarks }));
check("a fresh recover quote still publishes", recovered.client.publishes.some((row) => row.kind === "recover"));
console.log("fee-fresh checks", passed);
