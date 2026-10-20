import { fromKta } from "./pace.mjs";
import { makeBooks, makeClient, runCase } from "./fee-harness.mjs";

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function alerts(errors) {
  return errors.filter((line) => line.startsWith("ALERT "));
}

const foreignBooks = makeBooks(false);
const foreign = await runCase({
  books: foreignBooks,
  client: makeClient(foreignBooks, {
    pickQuote: fromKta("0.006"),
    customVotes: () => [{ fee: { amount: fromKta("0.001"), token: { id: "usdc" } } }],
  }),
  steps: 2,
});
const seen = alerts(foreign.errors);
check("a non-KTA fee publishes nothing", foreign.client.publishes.length === 0, String(foreign.client.publishes.length));
check("a non-KTA fee builds no fee block", foreign.client.feeBlockBuilds === 0, String(foreign.client.feeBlockBuilds));
check("a non-KTA fee alerts once", seen.length === 1 && /^ALERT Fee \d+\.\d{5} KTA is over the 0\.05000 KTA cap\. Backing off\.$/.test(seen[0]), seen.join("\n"));

const mixedBooks = makeBooks(false);
const mixed = await runCase({
  books: mixedBooks,
  client: makeClient(mixedBooks, {
    pickQuote: fromKta("0.006"),
    customVotes: () => [{
      fee: [
        { amount: fromKta("0.006") },
        { amount: fromKta("0.001"), token: "usdc" },
      ],
    }],
  }),
  steps: 1,
});
check("a mixed fee token publishes nothing", mixed.client.publishes.length === 0 && mixed.client.feeBlockBuilds === 0);
check("a mixed fee token alerts", alerts(mixed.errors).length === 1);

const namedBooks = makeBooks(false);
const named = await runCase({
  books: namedBooks,
  client: makeClient(namedBooks, {
    pickQuote: fromKta("0.006"),
    customVotes: () => [{ fee: { amount: fromKta("0.006"), token: { id: "base" } } }],
  }),
  steps: 1,
});
check("an explicit base-token fee still publishes", named.client.publishes.length === 1 && named.client.feeBlockBuilds === 1, String(named.client.feeBlockBuilds));

const omittedBooks = makeBooks(false);
const omitted = await runCase({
  books: omittedBooks,
  client: makeClient(omittedBooks, {
    pickQuote: fromKta("0.006"),
    customVotes: () => [{ fee: { amount: fromKta("0.006") } }],
  }),
  steps: 1,
});
check("an omitted fee token still publishes", omitted.client.publishes.length === 1 && omitted.client.feeBlockBuilds === 1);
console.log("fee-token checks", passed);
