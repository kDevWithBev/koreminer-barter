// Sample runner. Not installed on the server. No network and no real seed.
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounted, booksFromJson } from "./books.mjs";
import { main, INTAKE, MEMO } from "./refund.mjs";

const BASE = { id: "kta" };
const NOW = () => Date.parse("2026-10-20T12:00:00.000Z");
const FEE = 4n * 10n ** 15n;
const FIXTURE = readFileSync(new URL("./refund-fixture-books.json", import.meta.url));

function oldHistory() {
  return [{
    voteStaple: {
      timestamp: () => new Date("2026-10-01T00:00:00.000Z"),
      blocksHash: { toString: () => "OLD" },
      blocks: [],
    },
  }];
}

function hashOf(text) {
  return { toString: () => text };
}

function stage() {
  const dir = mkdtempSync(join(tmpdir(), "kore-sample-"));
  writeFileSync(join(dir, "books.json"), FIXTURE);
  const before = accounted(booksFromJson(JSON.parse(FIXTURE.toString("utf8"))));
  const live = { balance: before, history: oldHistory(), pending: null, hash: "SAMPLEHASH" };
  const quotes = [0, 1, 2, 3].map(() => ({ fee: { amount: 10n ** 15n, token: BASE } }));
  const client = {
    async balance() { return live.balance; },
    async pendingBlock() { return live.pending; },
    async getHistory() { return live.history; },
    async getQuotes() { return quotes; },
    async publishBuilder(_builder, options) {
      if (options?.generateFeeBlock) await options.generateFeeBlock({ votes: quotes });
      if (live.onPublish) return live.onPublish();
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(live.hash) }] } };
    },
    async send() { throw new Error("send"); },
    async recover() { throw new Error("recover"); },
    initBuilder() {
      const sends = [];
      return {
        send(to, amount, token, external) { sends.push({ to, amount, token, external }); },
        async computeBlocks() {
          return {
            blocks: [{
              hash: hashOf(live.hash),
              account: INTAKE,
              operations: sends.map((row) => ({
                type: 0,
                to: row.to,
                token: row.token,
                amount: row.amount,
                external: row.external,
              })),
            }],
          };
        },
        async computeFeeBlock() {
          return { operations: [{ type: 0, token: BASE, amount: FEE }] };
        },
      };
    },
  };
  return { dir, live, client, before };
}

async function show(heading, dir, client, argv) {
  const lines = [];
  const code = await main({
    dir,
    argv,
    client,
    base: BASE,
    baseText: "kta",
    now: NOW,
    output: (line) => lines.push(line),
    systemctl: () => "inactive",
    processes: () => [],
    loadWallet: () => ({ publicKeyString: INTAKE }),
    accountFrom: (id) => ({ publicKeyString: id }),
  });
  console.log(heading);
  console.log(lines.join("\n"));
  console.log("");
  return { code, lines };
}

function rawOf(total) {
  return BigInt(total.replace(".", ""));
}

const a = stage();
const noQuote = await show("(a) --no-quote dry run", a.dir, a.client, ["--no-quote"]);
if (noQuote.code !== 0) throw new Error("a");
const total = noQuote.lines.find((line) => line.startsWith("TOTAL ")).slice(6);
const count = noQuote.lines.find((line) => line.startsWith("N ")).slice(2);
const plan = noQuote.lines.find((line) => line.startsWith("PLAN ")).slice(5);
const raw = rawOf(total);

const b = stage();
const quoted = await show("(b) quoted dry run", b.dir, b.client, []);
if (quoted.code !== 0) throw new Error("b");

const c = stage();
c.live.onPublish = () => {
  c.live.history = [{
    voteStaple: {
      timestamp: () => new Date("2026-10-20T12:00:00.000Z"),
      blocksHash: { toString: () => "STAPLE" },
      blocks: [
        {
          account: INTAKE,
          hash: hashOf(c.live.hash),
          operations: [{ type: 0, external: MEMO, amount: 1n, token: BASE }],
        },
        {
          account: INTAKE,
          hash: hashOf("FEE"),
          operations: [{ type: 0, amount: FEE, token: BASE }],
        },
      ],
    },
  }, ...oldHistory()];
  c.live.balance -= raw + FEE;
  return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(c.live.hash) }] } };
};
const sent = await show("(c) --send landed", c.dir, c.client, ["--send", "--confirm-total", total, "--confirm-count", count, "--confirm-plan", plan]);
if (sent.code !== 0) throw new Error("c");

const verified = await show("(d) --verify no-op", c.dir, c.client, ["--verify"]);
if (verified.code !== 0) throw new Error("d");

const e = stage();
e.live.onPublish = () => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf(e.live.hash) }] } });
const missed = await main({
  dir: e.dir,
  argv: ["--send", "--confirm-total", total, "--confirm-count", count, "--confirm-plan", plan],
  client: e.client,
  base: BASE,
  baseText: "kta",
  now: NOW,
  output: () => {},
  systemctl: () => "inactive",
  processes: () => [],
  loadWallet: () => ({ publicKeyString: INTAKE }),
  accountFrom: (id) => ({ publicKeyString: id }),
});
if (missed !== 3) throw new Error("e send");
const notLanded = await show("(e) --verify NOT_LANDED", e.dir, e.client, ["--verify"]);
if (notLanded.code !== 3) throw new Error("e");

const f = stage();
f.live.onPublish = () => {
  f.live.history = [{
    voteStaple: {
      timestamp: () => new Date("2026-10-20T12:00:00.000Z"),
      blocksHash: { toString: () => "STAPLE" },
      blocks: [
        { account: INTAKE, hash: hashOf(f.live.hash), operations: [{ type: 0, external: MEMO, amount: 1n, token: BASE }] },
        { account: INTAKE, hash: hashOf("FEE"), operations: [{ type: 0, amount: FEE, token: BASE }] },
      ],
    },
  }, ...oldHistory()];
  f.live.balance -= raw + FEE;
  return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(f.live.hash) }] } };
};
const finished = await main({
  dir: f.dir,
  argv: ["--send", "--confirm-total", total, "--confirm-count", count, "--confirm-plan", plan],
  client: f.client,
  base: BASE,
  baseText: "kta",
  now: NOW,
  output: () => {},
  systemctl: () => "inactive",
  processes: () => [],
  loadWallet: () => ({ publicKeyString: INTAKE }),
  accountFrom: (id) => ({ publicKeyString: id }),
});
if (finished !== 0) throw new Error("f send");
const backup = readdirSync(f.dir).find((name) => name.startsWith("books.json.pre-refund-"));
rmSync(join(f.dir, "refund", "done.json"));
copyFileSync(join(f.dir, backup), join(f.dir, "books.json"));
const resume = await show("(f) --verify finishing", f.dir, f.client, ["--verify"]);
if (resume.code !== 0) throw new Error("f");

const g = stage();
const wrong = await show("(g) --send with a wrong --confirm-plan", g.dir, g.client, ["--send", "--confirm-total", total, "--confirm-count", count, "--confirm-plan", "0".repeat(64)]);
if (wrong.code !== 2) throw new Error("g");
