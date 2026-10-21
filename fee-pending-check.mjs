import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { ALICE, aliceDue, makeBooks, makeClient, readState, runCase } from "./fee-harness.mjs";

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

const start = Date.parse("2026-10-18T15:00:00.000Z");
const youngBooks = makeBooks(true);
const due = aliceDue(youngBooks);
const youngIntent = {
  from: ALICE,
  amount: due.toString(),
  key: "kore-alice",
  floor: (1_000_000n - due).toString(),
};
function pendingPick(date, hash) {
  return {
    hash: { toString() { return hash; } },
    date,
    operations: [{ type: 0, to: { id: "dust" }, amount: 1n, token: { id: "base" }, external: "pick" }],
  };
}

const youngClient = makeClient(youngBooks, {
  pickQuote: fromKta("0.006"),
  payoutQuote: fromKta("0.00404"),
  pending: pendingPick(new Date(start), "young-1"),
});
youngClient.recoverError = new Error("INSUFFICIENT_VOTING_WEIGHT");
const youngSnaps = [];
const young = await runCase({
  books: youngBooks,
  client: youngClient,
  send: true,
  steps: 3,
  clock: start,
  intent: youngIntent,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  },
  onSleep({ dir, client }) {
    youngSnaps.push({
      intent: existsSync(join(dir, "payout-intent.json")) ? readFileSync(join(dir, "payout-intent.json"), "utf8") : "",
      pubs: client.publishes.length,
      done: readState(dir).done,
    });
  },
});
check("a young pending block publishes no payout and no pick", young.client.publishes.length === 0, JSON.stringify(young.client.publishes));
check("the payout intent stays while the block is young", youngSnaps.length > 0 && youngSnaps.every((row) => row.intent === JSON.stringify(youngIntent)), JSON.stringify(youngSnaps));
check("a young block does not put the wallet in done", youngSnaps.every((row) => !row.done.includes(ALICE)));

const expBooks = makeBooks(true);
const expDue = aliceDue(expBooks);
const expIntent = {
  from: ALICE,
  amount: expDue.toString(),
  key: "kore-alice",
  floor: (1_000_000n - expDue).toString(),
};
const expClient = makeClient(expBooks, {
  pickQuote: fromKta("0.006"),
  payoutQuote: fromKta("0.00404"),
  voteFee: fromKta("6"),
  pending: pendingPick(new Date(start), "exp-1"),
});
const expYoung = [];
let opened = false;
const expired = await runCase({
  books: expBooks,
  client: expClient,
  send: true,
  // fix/rate-hold: an over-cap pick recover now writes FEEHOLD and waits in 10 s steps (no backoff ladder),
  // so it takes more loop steps to reach the 6 minute expiry.
  steps: 60,
  clock: start,
  intent: expIntent,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  },
  onSleep({ dir, client, time }) {
    const age = time.t - start;
    if (age < 6 * 60 * 1000) {
      expYoung.push({
        intent: existsSync(join(dir, "payout-intent.json")),
        pubs: client.publishes.length,
        builds: client.feeBlockBuilds,
        done: readState(dir).done.slice(),
        pending: client.pending !== null,
      });
      return;
    }
    if (!opened) {
      opened = true;
      client.voteFee = null;
    }
  },
});
check("an over-cap recover keeps the pending block while it is young", expYoung.length > 0 && expYoung.every((row) => row.pending && row.intent && row.pubs === 0 && row.builds === 0), JSON.stringify(expYoung));
check("a young over-cap recover does not rebuild a fee block", expYoung.every((row) => row.builds === 0) && expired.client.feeBlockBuilds === expired.client.publishes.length, `${expired.client.feeBlockBuilds} ${expired.client.publishes.map((row) => row.kind).join(",")}`);
check("the intent is kept until the pending block expires", expYoung.every((row) => row.intent) && !existsSync(join(expired.dir, "payout-intent.json")));
check("the expired payout is marked missed", expired.logs.some((line) => line === "KORE send did not land. Nothing was marked paid. Payout stays queued."));
check("the missed payout stays queued and retries once", expired.client.publishes.filter((row) => row.kind === "payout").length === 1, JSON.stringify(expired.client.publishes.map((row) => row.kind)));
check("the missed wallet is finished for this close", readState(expired.dir).done.includes(ALICE), JSON.stringify(readState(expired.dir).done));

const retryBooks = makeBooks(true);
const retryClient = makeClient(retryBooks, {
  pickQuote: fromKta("6"),
  payoutQuote: fromKta("6"),
  voteFee: fromKta("6"),
});
const retrySnaps = [];
let lowered = false;
const retry = await runCase({
  books: retryBooks,
  client: retryClient,
  send: true,
  steps: 4,
  clock: start,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  },
  onSleep({ dir, client }) {
    const saved = readState(dir);
    if (!lowered) {
      retrySnaps.push({ done: saved.done.slice(), pubs: client.publishes.filter((row) => row.kind === "payout").length });
      lowered = true;
      client.pickQuote = fromKta("0.006");
      client.payoutQuote = fromKta("0.00404");
      client.voteFee = null;
    }
  },
});
check("an over-cap payout is not marked done", retrySnaps.length === 1 && retrySnaps[0].done.includes(ALICE) === false && retrySnaps[0].pubs === 0, JSON.stringify(retrySnaps));
check("an over-cap payout retries in the same close", retry.client.publishes.filter((row) => row.kind === "payout").length === 1, JSON.stringify(retry.client.publishes.map((row) => row.kind)));

const voteBooks = makeBooks(true);
const voteClient = makeClient(voteBooks, {
  pickQuote: fromKta("0.006"),
  payoutQuote: fromKta("0.00404"),
  voteFee: fromKta("6"),
});
const voteSnaps = [];
let voteOpened = false;
const voteRetry = await runCase({
  books: voteBooks,
  client: voteClient,
  send: true,
  steps: 4,
  clock: start,
  state: {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  },
  onSleep({ dir, client }) {
    if (!voteOpened) {
      voteSnaps.push({
        done: readState(dir).done.slice(),
        intent: existsSync(join(dir, "payout-intent.json")),
        pubs: client.publishes.filter((row) => row.kind === "payout").length,
      });
      voteOpened = true;
      client.voteFee = null;
    }
  },
});
check("a vote-time over-cap payout is not in done and leaves no stuck intent", voteSnaps.length === 1 && voteSnaps[0].done.includes(ALICE) === false && voteSnaps[0].intent === false && voteSnaps[0].pubs === 0, JSON.stringify(voteSnaps));
check("a vote-time over-cap payout retries once fees fit", voteRetry.client.publishes.filter((row) => row.kind === "payout").length === 1, JSON.stringify(voteRetry.client.publishes.map((row) => row.kind)));

console.log("fee-pending checks", passed);
