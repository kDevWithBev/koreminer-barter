import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBooks } from "./books.mjs";
import { startMs } from "./ledger.mjs";
import { DAY_MS, FEE_PER_TX, fromKta } from "./pace.mjs";
import { makeBooks, makeClient, readState, runCase } from "./fee-harness.mjs";

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

const start = Date.parse("2026-10-18T15:00:00.000Z");
const thin = createBooks(startMs, fromKta("3"));
const poisoned = await runCase({
  books: thin,
  client: makeClient(thin, { pickQuote: fromKta("0.006") }),
  steps: 1,
  clock: start,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: fromKta("0.12").toString(),
    payoutFee: fromKta("0.12").toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: false,
  },
});
check("a poisoned 0.12 KTA fee publishes at the baseline pack", poisoned.client.publishes.length === 1 && poisoned.client.publishes[0].ops === 50, JSON.stringify(poisoned.client.publishes));
check("the saved fee is the 0.00012 KTA baseline", readState(poisoned.dir).feePerTx === FEE_PER_TX.toString(), readState(poisoned.dir).feePerTx);
check("a poisoned fee does not publish over the cap", poisoned.client.feeBlockBuilds === 1 && poisoned.client.publishes.length === 1);
check("payoutFee is not saved after load", !Object.hasOwn(readState(poisoned.dir), "payoutFee"), JSON.stringify(readState(poisoned.dir)));

const dayBooks = makeBooks(false);
const dayClient = makeClient(dayBooks, { pickQuote: fromKta("0.04") });
dayClient.fixedOps = 1;
const seen = [];
let jumped = false;
const rolled = await runCase({
  books: dayBooks,
  client: dayClient,
  steps: 2,
  clock: start,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: fromKta("0.0009").toString(),
    payoutFee: "1",
    payoutDay: "",
    done: [],
    closeOpen: false,
  },
  prepare({ dir, client }) {
    const orig = client.getHistory.bind(client);
    client.getHistory = async () => {
      try { seen.push(JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))); } catch { seen.push(null); }
      return orig();
    };
  },
  onSleep({ time }) {
    if (!jumped) {
      jumped = true;
      time.t += DAY_MS;
    }
  },
});
check("the new day was reached", seen.length >= 2 && rolled.logs.some((line) => line.startsWith("New day.")), JSON.stringify({ n: seen.length, logs: rolled.logs }));
check("a fee under cap/50 survives load", seen[0].feePerTx === fromKta("0.0009").toString(), seen[0]?.feePerTx);
check("the new-day reset clamps a raised fee back to baseline", seen[1].feePerTx === FEE_PER_TX.toString(), seen[1]?.feePerTx);
check("the new-day file does not keep payoutFee", !Object.hasOwn(seen[0], "payoutFee") && !Object.hasOwn(seen[1], "payoutFee") && !Object.hasOwn(readState(rolled.dir), "payoutFee"));

console.log("fee-clamp checks", passed);
