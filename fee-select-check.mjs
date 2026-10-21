import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { makeBooks, makeClient, readState, runCase } from "./fee-harness.mjs";

const start = Date.parse("2026-10-18T15:00:00.000Z");
const LINE = "Picks off. Payouts only.";
const FEE6 = "ALERT Fee 6.00000 KTA is over the 0.05000 KTA cap. Picks paused (FEEHOLD). Ask Keeta before removing FEEHOLD.";
const QUOTE_OVER = "ALERT Fee 0.06000 KTA is over the 0.05000 KTA cap. Picks paused (FEEHOLD). Ask Keeta before removing FEEHOLD.";
const NON_KTA = "ALERT Non-KTA fee selected. Picks paused (FEEHOLD). Ask Keeta before removing FEEHOLD.";
let passed = 0;

function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function alerts(errors) {
  return errors.filter((line) => line.startsWith("ALERT "));
}

function other(amount) {
  return { amount, token: { id: "other" } };
}

function ktaFee(amount) {
  return { amount };
}

function four(fee) {
  return [fee, fee, fee, fee].map((item) => ({ fee: item }));
}

function payoutState() {
  return {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  };
}

const savedPicks = process.env.PICKS_OFF;

try {
  delete process.env.PICKS_OFF;

  const mixedBooks = makeBooks(true);
  const mixedClient = makeClient(mixedBooks, {
    payoutQuote: fromKta("0.00404"),
    pickQuote: fromKta("0.006"),
    customVotes: () => four([ktaFee(fromKta("0.00101")), other(fromKta("0.5"))]),
  });
  mixedClient.getQuotes = async (blocks) => (blocks ?? []).map((block) => {
    const payout = (block?.operations ?? []).some((op) => op.token?.id === "kore");
    if (!payout) return { fee: ktaFee(fromKta("0.006")) };
    return { fee: [ktaFee(fromKta("0.00404")), other(fromKta("2"))] };
  });
  process.env.PICKS_OFF = "1";
  const mixed = await runCase({
    books: mixedBooks,
    client: mixedClient,
    send: true,
    steps: 1,
    clock: start,
    state: payoutState(),
  });
  const mixedPaid = mixed.client.publishes.filter((row) => row.kind === "payout");
  const mixedState = readState(mixed.dir);
  check("mixed options of 0.00101 and 0.5 publish", mixedPaid.length === 1 && mixed.client.feeBlockBuilds === 1, mixed.client.publishes.map((row) => row.kind).join(","));
  check("mixed options count 0.00404", mixed.logs.some((line) => line.startsWith("Published ") && line.includes("fee 0.00404 KTA")) && mixed.logs.includes("Payout fee 0.00404 KTA. Today 0.00404 KTA."), mixed.logs.filter((line) => line.includes("0.00404") || line.startsWith("Published ") || line.startsWith("ALERT ")).join("\n"));
  check("mixed options spend 0.00404 of the budget", mixedState.payoutFeeSpent === fromKta("0.00404").toString(), String(mixedState.payoutFeeSpent));
  check("mixed options do not alert", alerts(mixed.errors).length === 0, alerts(mixed.errors).join("\n"));

  delete process.env.PICKS_OFF;
  const highBooks = makeBooks(false);
  const high = await runCase({
    books: highBooks,
    client: makeClient(highBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => four([ktaFee(fromKta("1.5")), other(fromKta("0.001"))]),
    }),
    steps: 1,
    clock: start,
  });
  check("KTA 1.5 with a cheap other option is refused as 6", high.client.publishes.length === 0 && high.client.feeBlockBuilds === 0 && alerts(high.errors)[0] === FEE6, alerts(high.errors).join("\n"));

  const foreignBooks = makeBooks(false);
  const foreign = await runCase({
    books: foreignBooks,
    client: makeClient(foreignBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [{ fee: [other(fromKta("0.001"))] }],
    }),
    steps: 1,
    clock: start,
  });
  const foreignAlerts = alerts(foreign.errors);
  check("a vote with only a non-KTA option is refused", foreign.client.publishes.length === 0 && foreign.client.feeBlockBuilds === 0 && foreignAlerts.length === 1 && foreignAlerts[0] === NON_KTA, foreignAlerts.join("\n"));

  const freeBooks = makeBooks(false);
  const free = await runCase({
    books: freeBooks,
    client: makeClient(freeBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [
        { fee: [ktaFee(fromKta("0.004")), other(fromKta("0.5"))] },
        { fee: [ktaFee(fromKta("1.5")), { amount: 0n }] },
      ],
    }),
    steps: 1,
    clock: start,
  });
  check("a 0-amount option counts 0 for that vote", free.client.publishes.length === 1 && free.client.feeBlockBuilds === 1 && free.logs.some((line) => line.startsWith("Published ") && line.includes("fee 0.00400 KTA")), free.logs.filter((line) => line.startsWith("Published ") || line.startsWith("ALERT ")).join("\n") || free.errors.join("\n"));

  const matchedBooks = makeBooks(false);
  const matched = await runCase({
    books: matchedBooks,
    client: makeClient(matchedBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [{
        fee: {
          amount: fromKta("0.006"),
          token: { comparePublicKey(other) { return other?.id === "base"; } },
        },
      }],
    }),
    steps: 1,
    clock: start,
  });
  check("comparePublicKey matches the base token", matched.client.publishes.length === 1 && matched.client.feeBlockBuilds === 1, alerts(matched.errors).join("\n"));

  const unmatchedBooks = makeBooks(false);
  const unmatched = await runCase({
    books: unmatchedBooks,
    client: makeClient(unmatchedBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [{
        fee: {
          amount: fromKta("0.006"),
          token: { id: "base", comparePublicKey() { return false; } },
        },
      }],
    }),
    steps: 1,
    clock: start,
  });
  check("comparePublicKey false is foreign", unmatched.client.publishes.length === 0 && unmatched.client.feeBlockBuilds === 0 && alerts(unmatched.errors)[0] === NON_KTA, alerts(unmatched.errors).join("\n"));

  const quoteBooks = makeBooks(false);
  const quoteClient = makeClient(quoteBooks, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  quoteClient.getQuotes = async (blocks) => (blocks ?? []).map(() => ({
    fee: [ktaFee(fromKta("0.00101")), other(fromKta("0.5"))],
  }));
  const quoteOk = await runCase({ books: quoteBooks, client: quoteClient, steps: 1, clock: start });
  check("a mixed quote under the cap publishes", quoteOk.client.publishes.length === 1 && quoteOk.client.feeBlockBuilds === 1, alerts(quoteOk.errors).join("\n"));

  const overBooks = makeBooks(false);
  const overClient = makeClient(overBooks, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  overClient.getQuotes = async (blocks) => (blocks ?? []).map(() => ({
    fee: [ktaFee(fromKta("0.06")), other(fromKta("0.001"))],
  }));
  const quoteOver = await runCase({ books: overBooks, client: overClient, steps: 1, clock: start });
  check("a KTA quote over the cap is refused", quoteOver.client.publishes.length === 0 && quoteOver.client.feeBlockBuilds === 0 && alerts(quoteOver.errors)[0] === QUOTE_OVER, alerts(quoteOver.errors).join("\n"));

  const foreignQuoteBooks = makeBooks(false);
  const foreignQuoteClient = makeClient(foreignQuoteBooks, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  foreignQuoteClient.getQuotes = async (blocks) => (blocks ?? []).map(() => ({
    fee: [other(fromKta("0.001"))],
  }));
  const foreignQuote = await runCase({ books: foreignQuoteBooks, client: foreignQuoteClient, steps: 1, clock: start });
  const foreignQuoteAlerts = alerts(foreignQuote.errors);
  check("a non-KTA quote is refused", foreignQuote.client.publishes.length === 0 && foreignQuote.client.feeBlockBuilds === 0 && foreignQuoteAlerts.length === 1 && foreignQuoteAlerts[0] === NON_KTA, foreignQuoteAlerts.join("\n"));

  process.env.PICKS_OFF = "1";
  const offBooks = makeBooks(true);
  const off = await runCase({
    books: offBooks,
    client: makeClient(offBooks, {
      payoutQuote: fromKta("0.00404"),
      pickQuote: fromKta("0.006"),
      customVotes: () => [{ fee: [other(fromKta("0.001"))] }],
    }),
    send: true,
    steps: 1,
    clock: start,
    state: payoutState(),
  });
  check("picks-off is logged while a payout backs off", off.logs.filter((line) => line === LINE).length === 1 && off.client.publishes.length === 0 && alerts(off.errors).length === 1, [...off.logs.filter((line) => line === LINE), ...alerts(off.errors)].join("\n"));
} finally {
  if (savedPicks === undefined) delete process.env.PICKS_OFF;
  else process.env.PICKS_OFF = savedPicks;
}

console.log("fee-select checks", passed);
