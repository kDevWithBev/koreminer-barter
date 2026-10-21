import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { makeBooks, makeClient, readState, runCase } from "./fee-harness.mjs";

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

const start = Date.parse("2026-10-18T15:00:00.000Z");
const future = start + 3_600_000;
const books = makeBooks(false);
let corrected = null;
const ran = await runCase({
  books,
  client: makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") }),
  steps: 1,
  clock: start,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "",
    done: [],
    closeOpen: false,
    lastPublishMs: future,
  },
  onSleep({ dir, sleeps }) {
    if (sleeps.length === 1 && corrected === null) corrected = Number(readState(dir).lastPublishMs);
  },
});
// fix/rate-hold: the gap is 120 s (60 ledger blocks an hour, 2 blocks a publish).
check("a future publish time waits one gap", ran.sleeps[0] <= 120_000, String(ran.sleeps[0]));
check("a future publish time still publishes", ran.client.publishes.length === 1, String(ran.client.publishes.length));
check("a future publish time is saved as now", corrected === start, String(corrected));
console.log("fee-clock checks", passed);
