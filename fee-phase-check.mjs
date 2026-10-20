import { existsSync } from "node:fs";
import { join } from "node:path";
import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { ALICE, aliceDue, makeBooks, makeClient, readState, runCase, votesFor } from "./fee-harness.mjs";

const start = Date.parse("2026-10-18T15:00:00.000Z");
const LEAVE = "Picks off. Leaving the pending pick block to expire.";
const BUDGET = "ALERT Payout fee budget for today is used up (0.49000 of 0.50000 KTA). Payouts wait until the next UTC day.";
const VOTE_CAP = "ALERT Fee 0.03000 KTA is over the 0.02000 KTA cap. Backing off.";
let passed = 0;

function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function alerts(errors) {
  return errors.filter((line) => line.startsWith("ALERT "));
}

function stateOf(extra = {}) {
  return {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
    payoutFeeDay: "2026-10-18",
    payoutFeeSpent: "0",
    ...extra,
  };
}

const saved = {
  picks: process.env.PICKS_OFF,
  fee: process.env.FEE_CAP_PER_BUNDLE_KTA,
  cap: process.env.PAYOUT_FEE_CAP_KTA,
  budget: process.env.PAYOUT_FEE_BUDGET_KTA_PER_DAY,
};

function setEnv(env) {
  const write = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  write("PICKS_OFF", env.picks);
  write("FEE_CAP_PER_BUNDLE_KTA", env.fee);
  write("PAYOUT_FEE_CAP_KTA", env.cap);
  write("PAYOUT_FEE_BUDGET_KTA_PER_DAY", env.budget);
}

function blockOf(hash, operations, date = new Date(start)) {
  return { hash: { toString() { return hash; } }, date, operations };
}

function koreSend(amount, extra = {}) {
  return { type: 0, to: { id: "dest" }, amount, token: { id: "kore" }, external: "kore-alice", ...extra };
}

try {
  const dueBooks = makeBooks(true);
  const due = aliceDue(dueBooks);
  const intent = { from: ALICE, amount: due.toString(), key: "kore-alice", floor: "1000000" };

  setEnv({ picks: "1", fee: "0.01" });
  const pickBooks = makeBooks(false);
  const pick = await runCase({
    books: pickBooks,
    client: makeClient(pickBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      pending: blockOf("pick-1", [{ type: 0, to: { id: "dust" }, amount: 1n, token: { id: "base" }, external: "pick" }]),
    }),
    steps: 2,
    clock: start,
    state: stateOf(),
  });
  check("picks off leaves a pending pick unpublished", pick.client.publishes.length === 0 && pick.client.recoverCalls === 0, String(pick.client.publishes.length));
  check("picks off logs the pending pick once", pick.logs.filter((line) => line === LEAVE).length === 1, pick.logs.filter((line) => line === LEAVE).join("\n"));
  check("picks off waits out the pending pick", pick.sleeps.length === 2 && pick.sleeps.every((ms) => ms === 10000), pick.sleeps.join(","));

  setEnv({ picks: "1", fee: "0.01" });
  const payBooks = makeBooks(true);
  const pay = await runCase({
    books: payBooks,
    client: makeClient(payBooks, {
      pickQuote: fromKta("0.006"),
      payoutQuote: fromKta("0.02"),
      voteFee: fromKta("0.02"),
      pending: blockOf("pay-1", [koreSend(due)]),
    }),
    steps: 0,
    clock: start,
    intent,
    state: stateOf(),
  });
  const payState = readState(pay.dir);
  check("picks off recovers a matching payout", pay.client.publishes.some((row) => row.kind === "recover") && pay.client.publishes.every((row) => row.kind === "recover"), pay.client.publishes.map((row) => row.kind).join(","));
  check("a recovered payout uses the payout cap and records the fee", pay.logs.includes("Payout fee 0.02000 KTA. Today 0.02000 KTA.") && payState.payoutFeeSpent === fromKta("0.02").toString(), `${payState.payoutFeeSpent}\n${pay.errors.join("\n")}`);

  setEnv({ picks: "1" });
  const mixedBooks = makeBooks(true);
  const mixed = await runCase({
    books: mixedBooks,
    client: makeClient(mixedBooks, {
      pickQuote: fromKta("0.006"),
      payoutQuote: fromKta("0.00404"),
      pending: blockOf("mix-1", [koreSend(due), { type: 0, to: { id: "dust" }, amount: 1n, token: { id: "base" }, external: "pick" }]),
    }),
    steps: 1,
    clock: start,
    intent,
    state: stateOf(),
  });
  check("picks off leaves a mixed pending block unpublished", mixed.client.publishes.length === 0 && mixed.client.recoverCalls === 0, String(mixed.client.recoverCalls));

  const unknownBooks = makeBooks(true);
  const unknown = await runCase({
    books: unknownBooks,
    client: makeClient(unknownBooks, {
      pickQuote: fromKta("0.006"),
      pending: blockOf("odd-1", [{ type: 9, to: { id: "dest" }, amount: due, token: { id: "kore" }, external: "kore-alice" }]),
    }),
    steps: 1,
    clock: start,
    intent,
    state: stateOf(),
  });
  check("picks off leaves an unknown pending operation unpublished", unknown.client.publishes.length === 0 && unknown.client.recoverCalls === 0, String(unknown.client.recoverCalls));

  setEnv({ cap: "0.001" });
  const openBooks = makeBooks(false);
  const open = await runCase({
    books: openBooks,
    client: makeClient(openBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      pending: {
        date: new Date(start),
        blocks: [{ hash: "pick-open", operations: [{ type: 0, to: { id: "dust" }, amount: 1n, token: { id: "base" } }] }],
      },
    }),
    steps: 0,
    clock: start,
    state: stateOf(),
  });
  check("picks on recovers a pending pick under the pick cap", open.client.publishes.some((row) => row.kind === "recover") && readState(open.dir).payoutFeeSpent === "0", `${open.client.publishes.map((row) => row.kind).join(",")}\n${open.errors.join("\n")}`);

  setEnv({ picks: "1" });
  const tightBooks = makeBooks(true);
  const tightClient = makeClient(tightBooks, {
    payoutQuote: fromKta("0.01"),
    pickQuote: fromKta("0.006"),
    customVotes: ({ payout }) => votesFor(payout ? fromKta("0.03") : fromKta("0.006")),
  });
  tightClient.getQuotes = async (blocks) => (blocks ?? []).map((block) => {
    const payout = (block?.operations ?? []).some((op) => op.token?.id === "kore");
    return { fee: { amount: payout ? fromKta("0.01") : fromKta("0.006") } };
  });
  const tight = await runCase({
    books: tightBooks,
    client: tightClient,
    send: true,
    steps: 1,
    clock: start,
    state: stateOf({ payoutFeeSpent: fromKta("0.48").toString() }),
  });
  check("a 0.03 payout fee is refused by the 0.02 vote cap", tight.client.publishes.length === 0 && alerts(tight.errors)[0] === VOTE_CAP && !readState(tight.dir).done.includes(ALICE), alerts(tight.errors).join("\n"));

  const smallBooks = makeBooks(true);
  const smallClient = makeClient(smallBooks, {
    payoutQuote: fromKta("0.01"),
    pickQuote: fromKta("0.006"),
    voteFee: fromKta("0.01"),
  });
  smallClient.getQuotes = async (blocks) => (blocks ?? []).map((block) => {
    const payout = (block?.operations ?? []).some((op) => op.token?.id === "kore");
    return { fee: { amount: payout ? fromKta("0.01") : fromKta("0.006") } };
  });
  const small = await runCase({
    books: smallBooks,
    client: smallClient,
    send: true,
    steps: 1,
    clock: start,
    state: stateOf({ payoutFeeSpent: fromKta("0.48").toString() }),
  });
  check("a 0.01 payout fee publishes inside the vote cap", small.client.publishes.some((row) => row.kind === "payout") && readState(small.dir).payoutFeeSpent === fromKta("0.49").toString(), `${readState(small.dir).payoutFeeSpent}\n${alerts(small.errors).join("\n")}`);

  setEnv({ picks: "1", cap: "5", fee: "0.5" });
  const overBooks = makeBooks(true);
  const over = await runCase({
    books: overBooks,
    client: makeClient(overBooks, {
      payoutQuote: fromKta("0.02"),
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.02"),
      pending: blockOf("pay-budget", [koreSend(due)]),
    }),
    steps: 0,
    clock: start,
    intent,
    state: stateOf({ payoutFeeSpent: fromKta("0.49").toString() }),
  });
  check("a recovered payout over the budget stays queued", over.client.publishes.length === 0 && over.client.recoverCalls === 0 && alerts(over.errors).includes(BUDGET) && !readState(over.dir).done.includes(ALICE) && existsSync(join(over.dir, "payout-intent.json")), [...alerts(over.errors), ...over.logs.filter((line) => line.startsWith("Paid") || line.startsWith("Skip"))].join("\n"));
} finally {
  setEnv(saved);
}

console.log("fee-phase checks", passed);
