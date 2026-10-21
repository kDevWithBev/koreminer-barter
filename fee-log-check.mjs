import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { makeBooks, makeClient, runCase } from "./fee-harness.mjs";
process.env.PICKS_OFF = "0"; // fix/rate-hold r2: picks run only with PICKS_OFF=0 (missing or empty now means off)

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function published(logs) {
  return logs.filter((line) => line.startsWith("Published "));
}

const books = makeBooks(false);
const logged = await runCase({
  books,
  client: makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") }),
  steps: 1,
});
const lines = published(logged.logs);
check("a bundle publishes a line", lines.length === 1, lines.join("\n"));
check("every Published line shows the fee", lines.every((line) => / fee \d+\.\d{5} KTA /.test(line)), lines.join("\n"));
check("the Published line shows the fee that was paid", lines[0].includes("fee 0.00600 KTA"), lines[0]);
console.log(lines[0]);

const start = Date.parse("2026-10-18T15:00:00.000Z");
const payBooks = makeBooks(true);
const payClient = makeClient(payBooks, { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") });
let calls = 0;
const origPublish = payClient.publishBuilder.bind(payClient);
payClient.publishBuilder = async (builder, options) => {
  calls += 1;
  if (calls > 1) {
    payClient.baseBal -= payClient.pickQuote;
    payClient.publishes.push({ kind: "pick", ops: builder.ops.length });
    return { publish: true, voteStaple: { ok: true } };
  }
  return origPublish(builder, options);
};
const ordered = await runCase({
  books: payBooks,
  client: payClient,
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
  },
});
const order = published(ordered.logs);
check("a payout line shows that payout fee", order[0]?.includes("fee 0.00404 KTA"), order.join("\n"));
check("a later pick does not keep the payout fee", order[1]?.includes("fee 0.00000 KTA") && !order[1].includes("fee 0.00404"), order.join("\n"));

const recoverBooks = makeBooks(false);
let votes = 0;
const recoverClient = makeClient(recoverBooks, {
  pickQuote: fromKta("0.006"),
  pending: { date: new Date(start), blocks: [{ operations: [{ token: { id: "base" } }] }] },
  voteFee: () => {
    votes += 1;
    return votes === 1 ? fromKta("0.004") : fromKta("0.006");
  },
});
const recovered = await runCase({
  books: recoverBooks,
  client: recoverClient,
  steps: 1,
  clock: start,
});
const recoverLines = published(recovered.logs);
check("a recover line shows that recover fee", recoverLines[0]?.includes("fee 0.00400 KTA"), recoverLines.join("\n"));
check("a pick after recover shows the pick fee", recoverLines[1]?.includes("fee 0.00600 KTA"), recoverLines.join("\n"));
console.log("fee-log checks", passed);
