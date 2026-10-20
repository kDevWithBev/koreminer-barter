import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { makeBooks, makeClient, runCase } from "./fee-harness.mjs";

const ALERT = "ALERT Fee 3.00300 KTA is over the 0.05000 KTA cap. Backing off.";
let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function alerts(errors) {
  return errors.filter((line) => line.startsWith("ALERT "));
}

async function overQuote(kind) {
  const books = makeBooks(kind === "payout");
  const client = makeClient(books, {
    pickQuote: fromKta("3.003"),
    payoutQuote: fromKta("3.003"),
    voteFee: fromKta("3.003"),
  });
  let raised = false;
  const ran = await runCase({
    books,
    client,
    send: kind === "payout",
    steps: 3,
    state: kind === "payout" ? {
      windowStart: Date.parse("2026-10-18T15:00:00.000Z"),
      spent: "0",
      feePerTx: FEE_PER_TX.toString(),
      payoutDay: "2026-10-18",
      done: [],
      closeOpen: true,
    } : null,
    onSleep({ client: live }) {
      if (!raised) {
        raised = true;
        live.pickQuote = fromKta("6");
        live.payoutQuote = fromKta("6");
        live.voteFee = fromKta("6");
      }
    },
  });
  const seen = alerts(ran.errors);
  check(`a ${kind} quote of 3.003 then 6 alerts once`, seen.length === 1 && seen[0] === ALERT, seen.join("\n"));
  check(`a ${kind} over-cap quote backs off`, ran.sleeps[0] === 30_000 && ran.sleeps[1] === 60_000 && ran.sleeps[2] === 120_000, ran.sleeps.join(","));
  check(`a ${kind} over-cap quote publishes nothing`, ran.client.publishes.length === 0, String(ran.client.publishes.length));
  check(`a ${kind} over-cap quote is not a plain skip`, !ran.logs.some((line) => line.startsWith("Skip. Quote") || line.startsWith("Skip KORE. Quote")));
}

await overQuote("pick");
await overQuote("payout");
console.log("fee-quote checks", passed);
