import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { aliceDue, makeBooks, makeClient, readState, runCase } from "./fee-harness.mjs";

// fix/rate-hold: a pick over the cap writes FEEHOLD and stays paused (was: back off and retry).
const ALERT = "ALERT Fee 6.00000 KTA is over the 0.05000 KTA cap. Picks paused (FEEHOLD). Ask Keeta before removing FEEHOLD.";
let passed = 0;

function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function alerts(errors) {
  return errors.filter((line) => line.startsWith("ALERT "));
}

function show(result) {
  return JSON.stringify({
    pubs: result.client.publishes.map((row) => ({ ...row, amount: row.amount?.toString?.() })),
    logs: result.logs,
    errors: result.errors,
    builds: result.client.feeBlockBuilds,
  });
}

const dueBooks = makeBooks(true);
check("alice is due a payout", aliceDue(dueBooks) > 0n, String(aliceDue(dueBooks)));

const voteTime = await runCase({
  books: makeBooks(false),
  client: makeClient(makeBooks(false), { voteFee: fromKta("6"), pickQuote: fromKta("0.006") }),
  steps: 4,
});
check("a 6 KTA vote fee publishes nothing", voteTime.client.publishes.length === 0, JSON.stringify(voteTime.client.publishes));
check("a 6 KTA vote fee never builds the fee block", voteTime.client.feeBlockBuilds === 0);
check("a 6 KTA vote fee alerts once", alerts(voteTime.errors).join("\n") === ALERT, voteTime.errors.join("\n"));
check("over-cap does not use the 10s retry", voteTime.errors.every((line) => !line.startsWith("Retry.")));
check("an over-cap vote fee writes FEEHOLD and does not back off and retry", existsSync(join(voteTime.dir, "FEEHOLD")) && voteTime.sleeps.every((ms) => ms === 30000), JSON.stringify(voteTime.sleeps));

const resumedBooks = makeBooks(false);
const resumedClient = makeClient(resumedBooks, { voteFee: fromKta("6"), pickQuote: fromKta("0.006") });
const resumed = await runCase({
  books: resumedBooks,
  client: resumedClient,
  steps: 4,
  onSleep({ sleeps, client, dir }) {
    if (sleeps.filter((ms) => ms >= 30000).length === 1) client.voteFee = null;
    if (sleeps.filter((ms) => ms >= 30000).length === 2) {
      check("the fee drop alone does not resume picks", client.publishes.length === 0, JSON.stringify(client.publishes));
      try { unlinkSync(join(dir, "FEEHOLD")); } catch { /* none */ }
    }
  },
});
check("publishing resumes only after a person removes FEEHOLD", resumed.client.publishes.length === 1 && resumed.client.publishes[0].kind === "pick", JSON.stringify(resumed.client.publishes));
check("the resumed bundle is one fee block", resumed.client.feeBlockBuilds === 1);
check("the episode still alerts only once", alerts(resumed.errors).length === 1, resumed.errors.join("\n"));
check("the remembered fee never climbs", readState(resumed.dir).feePerTx === FEE_PER_TX.toString(), readState(resumed.dir).feePerTx);

const quotedBooks = makeBooks(false);
const quoted = await runCase({
  books: quotedBooks,
  client: makeClient(quotedBooks, { pickQuote: fromKta("6"), voteFee: fromKta("6") }),
  steps: 2,
});
check("a 6 KTA pick quote publishes nothing", quoted.client.publishes.length === 0, show(quoted));

const payBooks = makeBooks(true);
const pay = await runCase({
  books: payBooks,
  client: makeClient(payBooks, { pickQuote: fromKta("6"), payoutQuote: fromKta("6"), voteFee: fromKta("6") }),
  send: true,
  steps: 2,
  state: {
    windowStart: Date.parse("2026-10-18T15:00:00.000Z"),
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  },
});
check("a 6 KTA payout quote publishes nothing", pay.client.publishes.length === 0, show(pay));

const start = Date.parse("2026-10-18T15:00:00.000Z");
const recoverBooks = makeBooks(false);
const recover = await runCase({
  books: recoverBooks,
  client: makeClient(recoverBooks, {
    pickQuote: fromKta("6"),
    voteFee: fromKta("6"),
    pending: { date: new Date(start), blocks: [{ operations: [{ token: { id: "base" } }] }] },
  }),
  steps: 2,
  clock: start,
});
check("a 6 KTA recover quote publishes nothing", recover.client.publishes.length === 0, show(recover));
check("a 6 KTA recover fee is not signed", recover.client.feeBlockBuilds === 0);

const normalBooks = makeBooks(true);
const normal = await runCase({
  books: normalBooks,
  client: makeClient(normalBooks, { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") }),
  send: true,
  steps: 1,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  },
  clock: start,
});
check("a 0.00404 KTA payout still publishes", normal.client.publishes.some((row) => row.kind === "payout"), show(normal));
check("a 0.006 KTA pick still publishes", normal.client.publishes.some((row) => row.kind === "pick" && row.ops === 50), show(normal));
check("normal bundles build a fee block", normal.client.feeBlockBuilds === 2, String(normal.client.feeBlockBuilds));

const dearBooks = makeBooks(false);
const dear = await runCase({
  books: dearBooks,
  client: makeClient(dearBooks, { pickQuote: fromKta("0.04") }),
  steps: 1,
});
check("a quote under the cap is not climbed away", dear.client.publishes.length === 1, show(dear));
const learned = BigInt(readState(dear.dir).feePerTx);
check("the remembered pick fee is the quote per send", learned === fromKta("0.04") / 50n, learned.toString());
check("that remembered fee is not the old fourfold step", learned !== FEE_PER_TX * 4n);

console.log("fee-cap checks", passed);
