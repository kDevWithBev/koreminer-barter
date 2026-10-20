import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { ALICE, aliceDue, makeBooks, makeClient, runCase } from "./fee-harness.mjs";

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

const start = Date.parse("2026-10-18T15:00:00.000Z");
const books = makeBooks(true);
const amount = aliceDue(books);
const floor = 1_000_000n - amount;
const intent = {
  from: ALICE,
  amount: amount.toString(),
  key: "kore-alice",
  floor: floor.toString(),
};
const client = makeClient(books, {
  pickQuote: fromKta("0.006"),
  payoutQuote: fromKta("0.00404"),
  koreBal: floor + 5n,
  pending: { date: new Date(start - 7 * 60 * 1000) },
});
let jumped = false;
const ran = await runCase({
  books,
  client,
  send: true,
  steps: 4,
  clock: start,
  intent,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  },
  onSleep({ time }) {
    if (!jumped) {
      jumped = true;
      time.t += 24 * 60 * 60 * 1000;
    }
  },
});
const holdPath = join(ran.dir, "PAYHOLD");
const intentPath = join(ran.dir, "payout-intent.json");
const holds = [...ran.logs, ...ran.errors].filter((line) => line.includes("Balance does not match this payout."));
check("a stray deposit sets PAYHOLD", existsSync(holdPath) && readFileSync(holdPath, "utf8") === "Balance does not match this payout.\n");
check("the payout record is kept", existsSync(intentPath) && JSON.parse(readFileSync(intentPath, "utf8")).from === ALICE);
check("the mismatch is logged once", holds.length === 1, holds.join("\n"));
check("the next close does not pay again", ran.client.publishes.every((row) => row.kind !== "payout"), ran.client.publishes.map((row) => row.kind).join(","));
console.log("fee-expiry checks", passed);
