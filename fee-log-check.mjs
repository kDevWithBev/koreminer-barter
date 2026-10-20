import { fromKta } from "./pace.mjs";
import { makeBooks, makeClient, runCase } from "./fee-harness.mjs";

let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

const books = makeBooks(false);
const logged = await runCase({
  books,
  client: makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") }),
  steps: 1,
});
const lines = logged.logs.filter((line) => line.startsWith("Published "));
check("a bundle publishes a line", lines.length === 1, lines.join("\n"));
check("every Published line shows the fee", lines.every((line) => / fee \d+\.\d{5} KTA /.test(line)), lines.join("\n"));
check("the Published line shows the fee that was paid", lines[0].includes("fee 0.00600 KTA"), lines[0]);
console.log(lines[0]);
console.log("fee-log checks", passed);
