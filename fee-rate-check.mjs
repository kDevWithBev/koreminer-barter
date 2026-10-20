import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { booksToJson } from "./books.mjs";
import { minPublishGapMs } from "./pace.mjs";
import { makeBooks, makeClient, readState } from "./fee-harness.mjs";
import { fromKta } from "./pace.mjs";
import { runShaft } from "./run.mjs";

const say = console.log;
const yell = console.error;
let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  say("ok", name);
}

process.env.MAX_BLOCKS_PER_HOUR = "60";
const gap = minPublishGapMs();
const start = Date.parse("2026-10-18T15:00:00.000Z");
const hour = 3_600_000;
const books = makeBooks(false);
const dir = mkdtempSync(join(tmpdir(), "kore-rate-"));
writeFileSync(join(dir, "books.json"), JSON.stringify(booksToJson(books)));
const time = { t: start };
const client = makeClient(books, { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") });
client.pendingBlock = async () => ({ date: new Date(time.t - 1000) });
const origRecover = client.recover.bind(client);
client.recover = async (publish, options) => {
  const at = time.t;
  const before = client.publishes.length;
  const result = await origRecover(publish, options);
  if (client.publishes.length > before) client.publishes[client.publishes.length - 1].at = at;
  return result;
};
client.voteFee = fromKta("0.006");

console.log = () => {};
console.error = () => {};
async function go(steps) {
  await runShaft({
    dir,
    client,
    base: { id: "base" },
    baseText: "base",
    dustAccount: { id: "dust" },
    koreAccount: { id: "kore" },
    accountFrom: () => ({ id: "dest" }),
    now: () => time.t,
    sleep: async (ms) => { time.t += ms; },
    steps,
  });
}
try {
  await go(4);
  const saved = readState(dir);
  const last = Number(saved.lastPublishMs);
  check("the last publish time is saved", last > 0, String(last));
  time.t = last + 1000;
  const mark = client.publishes.length;
  await go(70);
  const later = client.publishes.slice(mark);
  const inHour = client.publishes.filter((row) => row.at < start + hour);
  const burst = later.filter((row) => row.at < last + gap);
  check("a restart does not publish inside the interval", later.length > 0 && burst.length === 0, JSON.stringify({ last, gap, first: later[0]?.at, burst: burst.length, total: client.publishes.length }));
  check("an hour holds at most 60 publishes", inHour.length <= 60, String(inHour.length));
  check("the limit still publishes through the hour", inHour.length === 60, String(inHour.length));
} finally {
  console.log = say;
  console.error = yell;
  delete process.env.MAX_BLOCKS_PER_HOUR;
}
console.log("fee-rate checks", passed);
