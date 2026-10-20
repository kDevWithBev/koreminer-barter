import { existsSync } from "node:fs";
import { join } from "node:path";
import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { ALICE, makeBooks, makeClient, readState, runCase } from "./fee-harness.mjs";

const start = Date.parse("2026-10-18T15:00:00.000Z");
const FEE6 = "ALERT Fee 6.00000 KTA is over the 0.05000 KTA cap. Backing off.";
const FEE15 = "ALERT Fee 1.50000 KTA is over the 0.05000 KTA cap. Backing off.";
const FEE007 = "ALERT Fee 0.00700 KTA is over the 0.05000 KTA cap. Backing off.";
const NON_KTA = "ALERT Non-KTA fee selected. Backing off.";
const EMPTY_OPTIONS = "Refused fee options: none, none, none";
const MIXED_OPTIONS = "Refused fee options: 1.50000, none, none; 0.00100, other, none";
const FOREIGN_OPTIONS = "Refused fee options: 0.00100, usdc, keeta_payee";
let passed = 0;

function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function alerts(errors) {
  return errors.filter((line) => line.startsWith("ALERT "));
}

function options(errors) {
  return errors.filter((line) => line.startsWith("Refused fee options: "));
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

  const sumBooks = makeBooks(false);
  const sum = await runCase({
    books: sumBooks,
    client: makeClient(sumBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [{
        fee: [
          { amount: fromKta("0.004") },
          { amount: fromKta("0.5"), token: { id: "other" } },
        ],
      }],
    }),
    steps: 1,
    clock: start,
  });
  check("a sum of all options over the cap still publishes the selection", sum.client.publishes.length === 1 && sum.logs.some((line) => line.startsWith("Published ") && line.includes("fee 0.00400 KTA")), alerts(sum.errors).join("\n"));

  const laterBooks = makeBooks(false);
  const later = await runCase({
    books: laterBooks,
    client: makeClient(laterBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [{
        fee: [
          { amount: fromKta("0.5"), token: { id: "other" } },
          { amount: fromKta("0.004") },
        ],
      }],
    }),
    steps: 1,
    clock: start,
  });
  check("a KTA option listed after a foreign one is still picked", later.client.publishes.length === 1 && later.client.feeBlockBuilds === 1 && later.logs.some((line) => line.includes("fee 0.00400 KTA")), alerts(later.errors).join("\n"));

  const oneBooks = makeBooks(false);
  const one = await runCase({
    books: oneBooks,
    client: makeClient(oneBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [{
        fee: [
          { amount: fromKta("1.5") },
          { amount: fromKta("0.001"), token: { id: "other" } },
        ],
      }],
    }),
    steps: 2,
    clock: start,
  });
  check("1.5 KTA selected plus a tiny foreign option is refused", one.client.publishes.length === 0 && one.client.feeBlockBuilds === 0 && alerts(one.errors)[0] === FEE15 && !alerts(one.errors).includes(NON_KTA), alerts(one.errors).join("\n"));
  check("a refused quote logs its fee options once", options(one.errors).length === 1 && options(one.errors)[0] === MIXED_OPTIONS, options(one.errors).join("\n"));

  const textZeroBooks = makeBooks(false);
  const textZero = await runCase({
    books: textZeroBooks,
    client: makeClient(textZeroBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [{ fee: [{ amount: fromKta("6") }, { amount: "0" }] }],
    }),
    steps: 1,
    clock: start,
  });
  check("a string 0 next to 6 KTA does not skip the vote", textZero.client.publishes.length === 0 && textZero.client.feeBlockBuilds === 0 && alerts(textZero.errors)[0] === FEE6, [...alerts(textZero.errors), ...textZero.logs.filter((line) => line.startsWith("Published "))].join("\n"));

  const foreignBooks = makeBooks(false);
  const foreign = await runCase({
    books: foreignBooks,
    client: makeClient(foreignBooks, {
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.006"),
      customVotes: () => [{ fee: { amount: fromKta("0.001"), token: { id: "usdc" }, payTo: "keeta_payee" } }],
    }),
    steps: 2,
    clock: start,
  });
  check("a non-KTA selection uses its own alert", foreign.client.publishes.length === 0 && alerts(foreign.errors).length === 1 && alerts(foreign.errors)[0] === NON_KTA, alerts(foreign.errors).join("\n"));
  check("a non-KTA refusal logs the raw option once", options(foreign.errors).length === 1 && options(foreign.errors)[0] === FOREIGN_OPTIONS, options(foreign.errors).join("\n"));

  const surchargeBooks = makeBooks(false);
  const surchargeClient = makeClient(surchargeBooks, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  surchargeClient.feeBlock = () => ({
    kind: "fee",
    operations: [{ type: 0, amount: fromKta("6"), token: { id: "base" } }],
  });
  const surcharge = await runCase({ books: surchargeBooks, client: surchargeClient, steps: 1, clock: start });
  check("a 6 KTA surcharge gives 0 publishes", surcharge.client.publishes.length === 0 && surcharge.client.feeBlockBuilds === 1 && alerts(surcharge.errors)[0] === FEE6, alerts(surcharge.errors).join("\n") || String(surcharge.client.publishes.length));

  const mismatchBooks = makeBooks(false);
  const mismatchClient = makeClient(mismatchBooks, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  mismatchClient.feeBlock = () => ({
    kind: "fee",
    operations: [{ type: 0, amount: fromKta("0.007"), token: { id: "base" } }],
  });
  const mismatch = await runCase({ books: mismatchBooks, client: mismatchClient, steps: 1, clock: start });
  check("a fee block whose ops do not match the selection is refused", mismatch.client.publishes.length === 0 && mismatch.client.feeBlockBuilds === 1 && alerts(mismatch.errors)[0] === FEE007, alerts(mismatch.errors).join("\n"));

  const foreignOpBooks = makeBooks(false);
  const foreignOpClient = makeClient(foreignOpBooks, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  foreignOpClient.feeBlock = () => ({
    kind: "fee",
    operations: [{ type: 0, amount: fromKta("0.006"), token: { id: "usdc" } }],
  });
  const foreignOp = await runCase({ books: foreignOpBooks, client: foreignOpClient, steps: 1, clock: start });
  check("a non-KTA send on the fee block is refused", foreignOp.client.publishes.length === 0 && alerts(foreignOp.errors)[0] === NON_KTA, alerts(foreignOp.errors).join("\n"));

  const zeroBooks = makeBooks(false);
  const zeroClient = makeClient(zeroBooks, { pickQuote: 0n, voteFee: 0n });
  zeroClient.getQuotes = async (blocks) => (blocks ?? []).map(() => ({ fee: { amount: 0n } }));
  zeroClient.customVotes = () => [{ fee: { amount: 0n } }, { fee: { amount: 0n } }];
  const zero = await runCase({ books: zeroBooks, client: zeroClient, steps: 1, clock: start });
  check("an all-zero quote publishes and is not marked done", zero.client.publishes.length === 1 && zero.client.publishes[0].kind === "pick" && readState(zero.dir).done.length === 0 && zero.logs.some((line) => line.startsWith("Published ") && line.includes("fee 0.00000 KTA")), [...zero.logs.filter((line) => line.startsWith("Published ") || line.startsWith("Skip")), ...zero.errors].join("\n"));

  process.env.PICKS_OFF = "1";
  const zeroPayBooks = makeBooks(true);
  const zeroPayClient = makeClient(zeroPayBooks, { payoutQuote: 0n, pickQuote: 0n });
  zeroPayClient.getQuotes = async (blocks) => (blocks ?? []).map(() => ({ fee: { amount: 0n } }));
  zeroPayClient.customVotes = () => [{ fee: { amount: 0n } }];
  const zeroPay = await runCase({
    books: zeroPayBooks,
    client: zeroPayClient,
    send: true,
    steps: 1,
    clock: start,
    state: payoutState(),
  });
  const zeroPaid = zeroPay.client.publishes.filter((row) => row.kind === "payout");
  check("an all-zero payout publishes", zeroPaid.length === 1 && zeroPay.logs.some((line) => line.startsWith("Paid ")) && !zeroPay.logs.some((line) => line.startsWith("Skip KORE. Quote")), zeroPay.logs.filter((line) => line.startsWith("Published ") || line.startsWith("Paid ") || line.startsWith("Skip") || line.startsWith("Payout fee")).join("\n") || zeroPay.errors.join("\n"));

  const emptyBooks = makeBooks(true);
  const emptyClient = makeClient(emptyBooks, { payoutQuote: fromKta("0.00404"), pickQuote: fromKta("0.006") });
  emptyClient.getQuotes = async () => [];
  const empty = await runCase({
    books: emptyBooks,
    client: emptyClient,
    send: true,
    steps: 2,
    clock: start,
    state: payoutState(),
  });
  check("an empty quote is queued and not marked done", empty.client.publishes.length === 0 && !readState(empty.dir).done.includes(ALICE) && !existsSync(join(empty.dir, "payout-intent.json")) && empty.sleeps.includes(30000) && !empty.logs.some((line) => line.startsWith("Skip KORE. Quote")), [...empty.logs.filter((line) => line.startsWith("Skip")), ...empty.errors].join("\n"));
  check("an empty quote logs its missing options once", options(empty.errors).length === 1 && options(empty.errors)[0] === EMPTY_OPTIONS, options(empty.errors).join("\n"));
} finally {
  if (savedPicks === undefined) delete process.env.PICKS_OFF;
  else process.env.PICKS_OFF = savedPicks;
}

console.log("fee-built checks", passed);
