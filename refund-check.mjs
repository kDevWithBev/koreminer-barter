import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounted, booksFromJson } from "./books.mjs";
import { main, DRAIN_SHA256, MEMO, INTAKE, REFUND_FEE_CAP } from "./refund.mjs";

const RAW = 10n ** 18n;
const BASE = { id: "kta" };
const BASE_TEXT = "kta";
const FIXTURE = new URL("./refund-fixture-books.json", import.meta.url);
const DRAIN = new URL("./refund-drain.json", import.meta.url);
const SINK = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const TREY_A = "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i";
const TREY_B = "keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy";
const BRIDGE = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const EXCLUDED = new Set([TREY_A, TREY_B, BRIDGE, INTAKE, SINK]);
const NOW = () => Date.parse("2026-10-20T12:00:00.000Z");
const FEE = 4n * 10n ** 15n;

const EXPECT = {
  aabd7qpx: "10558.233467",
  aab3cujp: "1497.191981",
  aab6z3pj: "1390.000000",
  aabemrl4: "960.606044",
  aabsq7gb: "851.638650",
  aab2mszm: "300.000000",
  aabal6jl: "133.365418",
  aabjln6p: "100.000000",
  aabbhuaq: "93.999606",
  aabffpbw: "92.192513",
  aabalimm: "91.354718",
  aabiilnj: "84.046341",
  aabjveq4: "54.447412",
  aabrmmct: "4.750445",
};

let passed = 0;
function check(name, ok) {
  if (!ok) throw new Error(name);
  passed += 1;
  console.log("ok", name);
}

function grab(lines, prefix) {
  const line = lines.find((item) => item.startsWith(prefix));
  if (!line) throw new Error(`missing ${prefix}`);
  return line.slice(prefix.length);
}

function has(lines, text) {
  return lines.some((line) => line.includes(text));
}

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

function staple(hash, fee, external = MEMO) {
  return {
    voteStaple: {
      timestamp: () => new Date("2026-10-20T12:00:00.000Z"),
      blocksHash: { toString: () => "STAPLE" },
      blocks: [
        {
          account: INTAKE,
          hash: hashOf(hash),
          operations: [{ type: 0, external, amount: 1n, token: BASE, to: "x" }],
        },
        {
          account: INTAKE,
          hash: hashOf("FEE"),
          operations: [{ type: 0, amount: fee, token: BASE, to: "fee" }],
        },
      ],
    },
  };
}

function defaultQuotes() {
  return [0, 1, 2, 3].map(() => ({ fee: { amount: 10n ** 15n, token: BASE } }));
}

function snapshot(dir) {
  const rows = [];
  function walk(path) {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else rows.push(`${full}:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  }
  walk(dir);
  return rows.join("\n");
}

function parseRows(lines) {
  const rows = [];
  for (const line of lines) {
    const match = line.match(/^(\d+) (keeta_[a-z0-9]+) stake (\S+) weight (\S+) addback (\S+) total (\S+) raw (\d+)$/);
    if (match) rows.push({ n: match[1], key: match[2], stake: match[3], weight: match[4], addback: match[5], total: match[6], raw: match[7] });
  }
  return rows;
}

async function run(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kore-refund-"));
  const booksPath = join(dir, "books.json");
  writeFileSync(booksPath, opts.booksText ?? readFileSync(FIXTURE));
  const books = booksFromJson(JSON.parse(readFileSync(booksPath, "utf8")));
  const live = {
    balance: opts.balance ?? accounted(books),
    pending: opts.pending ?? null,
    history: opts.history ?? oldHistory(),
    quotes: Object.prototype.hasOwnProperty.call(opts, "quotes") ? opts.quotes : [0, 1, 2, 3].map(() => ({ fee: { amount: 10n ** 15n, token: opts.base ?? BASE } })),
  };
  const counts = { publish: 0, send: 0, recover: 0, quotes: 0, builds: 0, feeBuilds: 0, init: 0, seed: 0, balance: 0, pending: 0 };
  const opened = [];
  const blockHash = opts.blockHash ?? "REFUNDHASH";
  let balanceReads = 0;
  let pendingReads = 0;
  const client = {
    async balance() {
      counts.balance += 1;
      balanceReads += 1;
      if (opts.onBalance) return opts.onBalance(balanceReads, live);
      return live.balance;
    },
    async pendingBlock() {
      counts.pending += 1;
      pendingReads += 1;
      if (opts.onPending) return opts.onPending(pendingReads, live);
      return live.pending;
    },
    async getQuotes() {
      counts.quotes += 1;
      if (opts.onQuote) await opts.onQuote(dir, live);
      return live.quotes;
    },
    async publishBuilder(builder, options) {
      counts.publish += 1;
      if (opts.onPublish) return opts.onPublish(builder, options, { dir, live, blockHash, counts });
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(blockHash) }] } };
    },
    async send() { counts.send += 1; throw new Error("send"); },
    async recover() { counts.recover += 1; throw new Error("recover"); },
    initBuilder() {
      counts.init += 1;
      const sends = [];
      return {
        sends,
        send(to, amount, token, external) { sends.push({ to, amount, token, external }); },
        async computeBlocks() {
          counts.builds += 1;
          if (opts.computeBlocks) return opts.computeBlocks(sends, blockHash);
          const operations = sends.map((row) => ({
            type: 0,
            to: row.to,
            token: row.token,
            amount: row.amount,
            external: row.external,
          }));
          const block = { hash: hashOf(blockHash), account: INTAKE, operations };
          client.lastBlock = block;
          client.sends = sends;
          return { blocks: [block] };
        },
        async computeFeeBlock(voteStaple) {
          counts.feeBuilds += 1;
          if (opts.computeFeeBlock) return opts.computeFeeBlock(voteStaple);
          let kta = 0n;
          for (const vote of voteStaple?.votes ?? []) {
            const fee = vote?.fee ?? vote;
            if (typeof fee?.amount === "bigint") kta += fee.amount;
          }
          if (opts.feeOverride !== undefined) kta = opts.feeOverride;
          return { operations: [{ type: 0, token: opts.base ?? BASE, amount: kta }] };
        },
      };
    },
  };
  if (opts.feeVotes) client.feeVotes = async () => opts.feeVotes;
  if (opts.useHistory) {
    client.history = async () => live.history;
  } else {
    client.getHistory = async () => {
      if (opts.getHistory) return opts.getHistory(live);
      return live.history;
    };
  }
  const fs = opts.trackReads ? {
    readFileSync: (path, ...args) => {
      opened.push(String(path));
      return readFileSync(path, ...args);
    },
  } : undefined;
  const baseDeps = {
    dir,
    now: opts.now ?? NOW,
    systemctl: opts.systemctl ?? (() => "inactive"),
    processes: opts.processes ?? (() => []),
    loadWallet: (walletDir) => {
      counts.seed += 1;
      if (opts.loadWallet) return opts.loadWallet(walletDir);
      return { publicKeyString: INTAKE };
    },
    accountFrom: opts.accountFrom ?? ((id) => ({ publicKeyString: id })),
    base: opts.base ?? BASE,
    baseText: opts.baseText ?? BASE_TEXT,
    client,
    fs,
    drainPath: opts.drainPath,
  };
  if (opts.drainSha !== undefined) baseDeps.drainSha = opts.drainSha;
  if (opts.plannerFault) baseDeps.plannerFault = opts.plannerFault;
  async function go(argv, extra = {}) {
    const lines = [];
    const code = await main({
      ...baseDeps,
      ...extra,
      argv,
      output: (line) => lines.push(line),
    });
    if (counts.send || counts.recover) throw new Error("client.send or client.recover was called");
    return { code, lines, dir, counts, opened, live, client, booksPath, booksBefore: readFileSync(booksPath) };
  }
  const first = await go(opts.argv ?? []);
  first.again = go;
  first.booksAtStart = readFileSync(booksPath);
  return first;
}

function reason(lines) {
  const line = lines.find((item) => item.startsWith("REFUND_REFUSED:"));
  return line ?? "";
}

let planCache;
async function plan() {
  if (planCache) return planCache;
  const dry = await run({ argv: ["--no-quote"] });
  planCache = {
    total: grab(dry.lines, "TOTAL "),
    n: grab(dry.lines, "N "),
    plan: grab(dry.lines, "PLAN "),
    lines: dry.lines,
  };
  return planCache;
}

function sendArgv(info, patch = {}) {
  return [
    "--send",
    "--confirm-total", patch.total ?? info.total,
    "--confirm-count", patch.n ?? info.n,
    "--confirm-plan", patch.plan ?? info.plan,
  ];
}

function land(info) {
  const total = BigInt(info.lines.find((line) => line.startsWith("TOTAL ")).slice(6).replace(".", "") );
  // TOTAL is 18 dp, so removing the dot is the raw integer only when there are exactly 18 dp.
  const raw = BigInt(grab(info.lines, "TOTAL ").replace(".", ""));
  return { raw, fee: FEE };
}

check("drain file sha matches the pin", createHash("sha256").update(readFileSync(DRAIN)).digest("hex") === DRAIN_SHA256);

const t1 = await run({ argv: ["--no-quote"] });
const rows = parseRows(t1.lines);
check("T1 fourteen rows", rows.length === 14 && t1.code === 0);
for (const [prefix, total] of Object.entries(EXPECT)) {
  const row = rows.find((item) => item.key.includes(prefix));
  check(`T1 ${prefix} total`, row?.total === total);
}
check("T1 pool", grab(t1.lines, "POOL ") === "1722.950000000000000000");
check("T1 addbacks", grab(t1.lines, "ADDBACKS ") === "1722.949999999999999994");
check("T1 dust", grab(t1.lines, "DUST ") === "6");
check("T1 raw total", grab(t1.lines, "TOTAL ") === "16211.826599999999999994");
check("T1 count", grab(t1.lines, "N ") === "14");
check("T1 excluded absent from sends", rows.every((row) => !EXCLUDED.has(row.key)));

const quoted = await run({ argv: [] });
check("T2 pool is excluded stake minus the fee budget", grab(quoted.lines, "POOL ") === "1722.950000000000000000");
const sentTo = (quoted.client.sends ?? []).map((row) => row.to.publicKeyString);
check("T2 excluded keys are not recipients", sentTo.length === 14 && sentTo.every((key) => !EXCLUDED.has(key)));
{
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const extra = (10n * RAW).toString();
  raw.stake[TREY_A] = (BigInt(raw.stake[TREY_A]) + 10n * RAW).toString();
  raw.lots.find((lot) => lot.from === TREY_A).remaining = raw.stake[TREY_A];
  const varied = await run({ argv: [], booksText: JSON.stringify(raw) });
  check("T2 pool follows Trey stake", grab(varied.lines, "POOL ") === "1732.950000000000000000");
  check("T2 changed Trey stake is still excluded", !(varied.client.sends ?? []).some((row) => row.to.publicKeyString === TREY_A));
}

const capOk = await run({ argv: [], quotes: [{ fee: { amount: REFUND_FEE_CAP, token: BASE } }] });
check("T3 exact fee cap passes", capOk.code === 0 && has(capOk.lines, "REFUND_DRY_RUN_OK") && capOk.counts.publish === 0);
const capOver = await run({
  argv: [],
  quotes: [{ fee: { amount: REFUND_FEE_CAP + 1n, token: BASE } }],
  feeVotes: [{ fee: { amount: 1n, token: BASE } }],
});
check("T3 one raw unit over the cap is refused", capOver.code === 2 && capOver.counts.publish === 0 && capOver.counts.feeBuilds === 0 && has(capOver.lines, "quote is over the refund fee cap"));
const voteOver = await run({
  argv: [],
  quotes: [{ fee: { amount: 1000n, token: BASE } }],
  feeVotes: [{ fee: { amount: REFUND_FEE_CAP + 1n, token: BASE } }],
});
check("T3 vote-time cap is inside generateFeeBlock", voteOver.code === 2 && voteOver.counts.feeBuilds === 0 && voteOver.counts.publish === 0 && has(voteOver.lines, "vote fee is over the refund fee cap"));
const builtBad = await run({ argv: [], feeOverride: 1n });
check("T3 built fee block must match the vote", builtBad.code === 2 && builtBad.counts.publish === 0 && has(builtBad.lines, "built fee block does not match"));
const foreign = await run({
  argv: [],
  quotes: defaultQuotes(),
  feeVotes: [{ fee: { amount: 1n, token: "keeta_notkta" } }],
});
check("T3 a non-KTA vote fee is refused", foreign.code === 2 && foreign.counts.feeBuilds === 0 && foreign.counts.publish === 0 && has(foreign.lines, "vote fee is non-KTA"));

const dry = await run({ argv: [] });
check("T4 dry run does not publish", dry.code === 0 && dry.counts.publish === 0 && dry.counts.send === 0 && dry.counts.recover === 0);
check("T4 dry run leaves no stop or intent", !existsSync(join(dry.dir, "STOP")) && !existsSync(join(dry.dir, "refund", "intent.json")));
check("T4 books stay byte identical", readFileSync(dry.booksPath).equals(dry.booksAtStart));
check("T4 dry run marker", has(dry.lines, "REFUND_DRY_RUN_OK") && !has(dry.lines, "REFUND_DRY_RUN_OK (no quote)"));

{
  const info = await plan();
  const withIntent = await run({ argv: ["--no-quote"] });
  writeFileSync(join(withIntent.dir, "refund", "intent.json"), `${JSON.stringify({ block: "H", total: "1.000000000000000000" })}\n`);
  const againIntent = await withIntent.again([]);
  check("T5 intent refuses before a quote", againIntent.code === 2 && withIntent.counts.quotes === 0 && has(againIntent.lines, "prior refund intent"));
  const withDone = await run({ argv: ["--no-quote"] });
  writeFileSync(join(withDone.dir, "refund", "done.json"), `${JSON.stringify({ block: "H", total: "1.000000000000000000" })}\n`);
  const quotesBefore = withDone.counts.quotes;
  const againDone = await withDone.again([]);
  check("T5 done refuses before a quote", againDone.code === 2 && withDone.counts.quotes === quotesBefore && has(againDone.lines, "prior refund done"));
  const landed = await run({
    argv: sendArgv(info),
    onPublish: (_builder, _options, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= land(info).raw + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T5 first send lands", landed.code === 0 && landed.counts.publish === 1 && has(landed.lines, "REFUND_SENT_OK"));
  const second = await landed.again(sendArgv(info));
  check("T5 second send does not publish again", second.code === 2 && landed.counts.publish === 1);
}

check("T6 active runner is refused", (await run({ argv: [], systemctl: () => "active" })).code === 2);
check("T6 activating runner is refused", (await run({ argv: [], systemctl: () => "activating" })).code === 2 && (await run({ argv: ["--no-quote"], systemctl: () => "activating" })).counts.quotes === 0);

for (const name of ["STOP", "HALT", "PAYHOLD", "FEEHOLD"]) {
  const held = await run({ argv: ["--no-quote"] });
  writeFileSync(join(held.dir, name), "held\n");
  const refused = await held.again(["--no-quote"]);
  check(`T7 ${name} is refused`, refused.code === 2 && has(refused.lines, `${name} is present`) && held.counts.quotes === 0);
}
{
  const held = await run({ argv: ["--no-quote"] });
  writeFileSync(join(held.dir, "payout-intent.json"), "{}\n");
  const refused = await held.again(["--no-quote"]);
  check("T7 payout-intent is refused", refused.code === 2 && has(refused.lines, "payout-intent.json is present"));
}

{
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.operator = (-1n * RAW).toString();
  const text = JSON.stringify(raw);
  const short = await run({ argv: [], booksText: text });
  const floor = BigInt(grab(await plan().then((info) => info.lines), "TOTAL ").replace(".", "")) + FEE + 2n * RAW;
  const have = accounted(booksFromJson(JSON.parse(text)));
  check("T8 setup is below the floor and still booked", have < floor && have === short.live.balance);
  check("T8 a short balance is refused", short.code === 2 && short.counts.publish === 0 && has(short.lines, "balance is short of the refund"));
}

check("T9 balance one raw above is refused", (await run({ argv: ["--no-quote"], balance: accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")))) + 1n })).code === 2);
{
  const above = await run({ argv: ["--no-quote"], balance: accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")))) + 1n });
  const below = await run({ argv: ["--no-quote"], balance: accounted(booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")))) - 1n });
  check("T9 both directions name the difference", above.code === 2 && below.code === 2 && has(above.lines, "difference 1.") && has(below.lines, "difference -1.") && has(above.lines, "Do not edit books. Unbooked deposits need a reviewed booking step first."));
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.pendingDrops = ["1"];
  const drops = await run({ argv: ["--no-quote"], booksText: JSON.stringify(raw) });
  check("T9 pending drops are refused", drops.code === 2 && has(drops.lines, "pending drops are not empty") && has(drops.lines, "Do not edit books. Unbooked deposits need a reviewed booking step first."));
}

{
  const info = await plan();
  const missingTotal = await run({ argv: ["--send", "--confirm-count", info.n, "--confirm-plan", info.plan] });
  const missingCount = await run({ argv: ["--send", "--confirm-total", info.total, "--confirm-plan", info.plan] });
  const missingPlan = await run({ argv: ["--send", "--confirm-total", info.total, "--confirm-count", info.n] });
  const wrongTotal = await run({ argv: sendArgv(info, { total: "16211.826599999999999995" }) });
  const wrongCount = await run({ argv: sendArgv(info, { n: "13" }) });
  const wrongPlan = await run({ argv: sendArgv(info, { plan: `${info.plan.slice(0, -1)}0` }) });
  for (const [name, result] of [["total flag", missingTotal], ["count flag", missingCount], ["plan flag", missingPlan], ["total", wrongTotal], ["count", wrongCount], ["plan", wrongPlan]]) {
    check(`T10 ${name} is refused`, result.code === 2 && result.counts.publish === 0 && has(result.lines, "REFUND_REFUSED:"));
  }
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const landed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const afterBooks = booksFromJson(JSON.parse(readFileSync(landed.booksPath, "utf8")));
  check("T11 landed finishes", landed.code === 0 && has(landed.lines, "REFUND_SENT_OK") && has(landed.lines, "BOOKS_OK"));
  check("T11 receipt and done exist", existsSync(join(landed.dir, "refund", "done.json")) && readdirSync(join(landed.dir, "refund")).some((name) => name.startsWith("receipt-")));
  check("T11 books backup exists", readdirSync(landed.dir).some((name) => name.startsWith("books.json.pre-refund-")));
  check("T11 accounted matches the chain", accounted(afterBooks) === landed.live.balance);
  check("T11 refunded and excluded stake is gone", [...EXCLUDED, ...Object.keys(EXPECT)].every((key) => {
    const full = [...afterBooks.share.stake.keys()].find((item) => item.includes(key)) ?? [...EXCLUDED].find((item) => item.includes(key));
    const id = [...afterBooks.share.stake.keys(), ...EXCLUDED].find((item) => String(item).includes(key));
    return (afterBooks.share.stake.get(id) ?? 0n) === 0n && !afterBooks.share.lots.some((lot) => lot.from === id || lot.from.includes(key));
  }));
  const missed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } }),
  });
  check("T11 not landed keeps the books", missed.code === 3 && has(missed.lines, "REFUND_NOT_LANDED:") && existsSync(join(missed.dir, "refund", "intent.json")) && readFileSync(missed.booksPath).equals(missed.booksAtStart));
  const boom = await run({
    argv: sendArgv(info),
    onPublish: () => {
      const err = new Error("nope");
      err.name = "PublishBoom";
      throw err;
    },
  });
  check("T11 a publish error holds", boom.code === 3 && boom.counts.recover === 0 && existsSync(join(boom.dir, "STOP")) && existsSync(join(boom.dir, "refund", "intent.json")) && has(boom.lines, "REFUND_HOLD: publish error PublishBoom"));
}

{
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.stake["base:0xfeed"] = RAW.toString();
  const bad = await run({ argv: ["--no-quote"], booksText: JSON.stringify(raw) });
  check("T12 a base key with stake is refused", bad.code === 2 && has(bad.lines, "unpayable stake"));
  const decode = await run({
    argv: ["--no-quote"],
    accountFrom: (id) => {
      if (id.includes("aabd7qpx")) throw new Error("decode");
      return { publicKeyString: id };
    },
  });
  check("T12 an undecodable address is refused", decode.code === 2 && decode.counts.init === 0 && has(decode.lines, "address does not decode"));
}

{
  const pending = await run({ argv: ["--no-quote"], pending: { hash: hashOf("PEND") } });
  check("T13 a pending block is refused", pending.code === 2 && pending.counts.quotes === 0 && has(pending.lines, "a block is already pending"));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  process.env.REFUND_ENV_CANARY = "ENV-CANARY-3K";
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let leaked;
  try {
    const landed = await run({
      argv: sendArgv(info),
      trackReads: true,
      loadWallet: (dir) => {
        writeFileSync(join(dir, "seed.txt"), "SEED-CANARY-9P\n");
        const text = readFileSync(join(dir, "seed.txt"), "utf8");
        if (!text.includes("SEED-CANARY-9P")) throw new Error("missing seed canary");
        return { publicKeyString: INTAKE };
      },
      onPublish: (_b, _o, ctx) => {
        ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
        ctx.live.balance -= rawTotal + FEE;
        return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
      },
    });
    writeFileSync(join(landed.dir, "seed.txt"), "SEED-CANARY-9P\n");
    const dryAfter = await landed.again([]);
    const verified = await landed.again(["--verify"]);
    const blob = [landed.lines.join("\n"), dryAfter.lines.join("\n"), verified.lines.join("\n"), errors.join("\n")];
    const refundDir = join(landed.dir, "refund");
    for (const name of readdirSync(refundDir)) {
      const full = join(refundDir, name);
      blob.push(readFileSync(full, "utf8"));
      check(`T14 ${name} is mode 0600`, (statSync(full).mode & 0o777) === 0o600);
    }
    check("T14 refund dir is mode 0700", (statSync(refundDir).mode & 0o777) === 0o700);
    const text = blob.join("\n");
    leaked = text;
    check("T14 canaries stay out of output and refund files", !text.includes("SEED-CANARY-9P") && !text.includes("ENV-CANARY-3K") && !text.includes("BOOKS-CANARY-7Q"));
  } finally {
    console.error = originalError;
    delete process.env.REFUND_ENV_CANARY;
  }
  const wrong = await run({ argv: [], loadWallet: () => ({ publicKeyString: "keeta_not_the_intake" }) });
  check("T14 a key that is not the intake is refused", wrong.code === 2 && wrong.counts.publish === 0 && has(wrong.lines, "seed is not the intake wallet"));
  void leaked;
}

{
  let sdk = null;
  try { sdk = await import("@keetanetwork/keetanet-client"); } catch { /* try the local install */ }
  if (!sdk) {
    try { sdk = await import("/tmp/keeta-0188/node_modules/@keetanetwork/keetanet-client/client/index.js"); } catch { sdk = null; }
  }
  if (!sdk) {
    console.log("T15 skipped: @keetanetwork/keetanet-client 0.18.8 could not be imported");
  } else {
    const version = JSON.parse(readFileSync("/tmp/keeta-0188/node_modules/@keetanetwork/keetanet-client/package.json", "utf8")).version;
    check("T15 sdk is 0.18.8", version === "0.18.8");
    const Account = sdk.lib.Account;
    const Block = sdk.lib.Block;
    const base = Account.generateBaseAddresses(0x5382n).baseToken;
    const baseText = base.publicKeyString.toString();
    const info = await plan();
    const planned = parseRows(info.lines);
    async function seal(mutator) {
      const wallet = Account.fromSeed(Account.generateRandomSeed({ asString: true }), 0);
      const builder = new Block.Builder({
        version: 2,
        network: 0x5382n,
        previous: Block.getAccountOpeningHash(wallet),
        account: wallet,
        signer: wallet,
      });
      const ops = planned.map((row) => ({ key: row.key, amount: BigInt(row.raw) }));
      mutator(ops);
      for (const op of ops) {
        builder.addOperation({
          type: 0,
          to: Account.fromPublicKeyString(op.key),
          amount: op.amount,
          token: base,
          external: MEMO,
        });
      }
      return builder.seal();
    }
    const good = await seal(() => {});
    const accepted = await run({
      argv: [],
      base,
      baseText,
      computeBlocks: () => ({ blocks: [good] }),
    });
    check("T15 a real sealed batch is accepted", accepted.code === 0 && has(accepted.lines, "REFUND_DRY_RUN_OK"));
    const changed = await seal((ops) => { ops[0].amount += 1n; });
    const rejectedAmount = await run({ argv: [], base, baseText, computeBlocks: () => ({ blocks: [changed] }) });
    check("T15 a raw unit change is refused", rejectedAmount.code === 2 && has(rejectedAmount.lines, "batch shape is wrong"));
    const swapped = await seal((ops) => {
      const key = ops[0].key;
      ops[0].key = ops[1].key;
      ops[1].key = key;
    });
    const rejectedSwap = await run({ argv: [], base, baseText, computeBlocks: () => ({ blocks: [swapped] }) });
    check("T15 a swapped recipient is refused", rejectedSwap.code === 2 && has(rejectedSwap.lines, "batch shape is wrong"));
    const pending = await run({ argv: ["--no-quote"], pending: good });
    check("T15 a real pending block is refused", pending.code === 2 && has(pending.lines, "a block is already pending"));
    const recorded = await run({
      argv: sendArgv(info),
      base,
      baseText,
      computeBlocks: () => ({ blocks: [good] }),
      onPublish: () => ({ from: "direct", voteStaple: { blocks: [{ hash: good.hash }] } }),
    });
    const intent = JSON.parse(readFileSync(join(recorded.dir, "refund", "intent.json"), "utf8"));
    check("T15 intent stores BlockHash toString", intent.block === good.hash.toString());
  }
}

{
  async function memo(external, argv) {
    return run({
      argv,
      history: [staple("MEMOHASH", 1n, external), ...oldHistory()],
    });
  }
  const info = await plan();
  for (const argv of [[], ["--no-quote"], sendArgv(info)]) {
    const asText = await memo(MEMO, argv);
    const asBytes = await memo(Buffer.from(MEMO), argv);
    check(`T16 memo string refuses ${argv.join(" ") || "dry-run"}`, asText.code === 2 && asText.counts.quotes === 0 && asText.counts.publish === 0 && has(asText.lines, "MEMOHASH"));
    check(`T16 memo bytes refuses ${argv.join(" ") || "dry-run"}`, asBytes.code === 2 && asBytes.counts.quotes === 0 && asBytes.counts.publish === 0 && has(asBytes.lines, "MEMOHASH"));
  }
  let page = 0;
  const capped = await run({
    argv: [],
    getHistory: async () => {
      page += 1;
      return Array.from({ length: 100 }, (_, index) => ({
        voteStaple: {
          timestamp: () => new Date("2026-10-20T00:00:00.000Z"),
          blocksHash: { toString: () => `P${page}-${index}` },
          blocks: [],
        },
      }));
    },
  });
  check("T16 the page cap refuses", capped.code === 2 && page === 300 && capped.counts.quotes === 0 && has(capped.lines, "history page cap hit before cutoff"));
  const thrown = await run({ argv: [], getHistory: async () => { throw new Error("down"); } });
  check("T16 a history error refuses", thrown.code === 2 && has(thrown.lines, "history read failed"));
  let later = 0;
  const partial = await run({
    argv: ["--no-quote"],
    getHistory: async () => {
      later += 1;
      if (later > 1) throw new Error("later");
      return Array.from({ length: 100 }, (_, index) => ({
        voteStaple: {
          timestamp: () => new Date("2026-10-20T00:00:00.000Z"),
          blocksHash: { toString: () => `L${index}` },
          blocks: [],
        },
      }));
    },
  });
  check("T16 an error on a later page refuses", partial.code === 2 && later === 2 && has(partial.lines, "history read failed"));
  const viaHistory = await run({
    argv: ["--no-quote"],
    useHistory: true,
    history: [staple("HISTHASH", 1n), ...oldHistory()],
  });
  check("T16 history() fallback sees the memo", viaHistory.code === 2 && has(viaHistory.lines, "HISTHASH"));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const missingHash = await run({
    argv: sendArgv(info),
    onPublish: () => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf("OTHER") }] } }),
  });
  check("T17 a staple without the hash holds", missingHash.code === 3 && has(missingHash.lines, "REFUND_HOLD: published staple does not contain the block") && readFileSync(missingHash.booksPath).equals(missingHash.booksAtStart));
  const balanceOnly = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a matching balance without the hash does not land", balanceOnly.code === 3 && !has(balanceOnly.lines, "REFUND_SENT_OK") && !has(balanceOnly.lines, "BOOKS_OK") && readFileSync(balanceOnly.booksPath).equals(balanceOnly.booksAtStart));
  const deposit = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance = ctx.live.balance - rawTotal - FEE + 1n;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a deposit after publish holds", deposit.code === 3 && has(deposit.lines, "REFUND_HOLD:") && !has(deposit.lines, "REFUND_NOT_LANDED:") && readFileSync(deposit.booksPath).equals(deposit.booksAtStart));
  const drifted = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.balance += 1n;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a balance change without the hash holds", drifted.code === 3 && has(drifted.lines, "REFUND_HOLD:") && !has(drifted.lines, "REFUND_NOT_LANDED:"));
  const pending = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.pending = { hash: hashOf("STILL") };
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a missing hash with a pending block is pending", pending.code === 3 && has(pending.lines, "REFUND_PENDING:") && has(pending.lines, "hash found no"));
  const fatFee = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, REFUND_FEE_CAP + 1n), ...oldHistory()];
      ctx.live.balance -= rawTotal + REFUND_FEE_CAP + 1n;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a fee over the cap holds", fatFee.code === 3 && has(fatFee.lines, "REFUND_HOLD:") && !has(fatFee.lines, "BOOKS_OK"));
  const otherFee = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, 1n), ...oldHistory()];
      ctx.live.balance -= rawTotal + 1n;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T17 a fee that differs from the vote holds", otherFee.code === 3 && has(otherFee.lines, "REFUND_HOLD:") && readFileSync(otherFee.booksPath).equals(otherFee.booksAtStart));
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const landed = await run({
    argv: sendArgv(info),
    trackReads: true,
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const backup = readdirSync(landed.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  rmSync(join(landed.dir, "refund", "done.json"));
  copyFileSync(join(landed.dir, backup), landed.booksPath);
  const seeds = landed.counts.seed;
  const quotes = landed.counts.quotes;
  const inits = landed.counts.init;
  const publishes = landed.counts.publish;
  const first = await landed.again(["--verify"]);
  check("T18 verify finishes a landed refund once", first.code === 0 && has(first.lines, "REFUND_VERIFY: LANDED (finished now)") && has(first.lines, "BOOKS_OK"));
  const shot = snapshot(landed.dir);
  const second = await landed.again(["--verify"]);
  check("T18 a second verify is a no-op", second.code === 0 && has(second.lines, "REFUND_VERIFY: LANDED (already finished)") && snapshot(landed.dir) === shot);
  check("T18 verify does not build quote or publish", landed.counts.seed === seeds && landed.counts.quotes === quotes && landed.counts.init === inits && landed.counts.publish === publishes && !landed.opened.some((path) => path.endsWith("seed.txt")));

  const missed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => ({ from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } }),
  });
  const beforeMiss = snapshot(missed.dir);
  const verifyMiss = await missed.again(["--verify"]);
  check("T18 verify of not landed writes nothing", verifyMiss.code === 3 && has(verifyMiss.lines, "REFUND_VERIFY: NOT_LANDED") && snapshot(missed.dir) === beforeMiss);

  const still = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.pending = { hash: hashOf("STILL") };
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const beforeStill = snapshot(still.dir);
  const verifyStill = await still.again(["--verify"]);
  check("T18 verify of pending writes nothing", verifyStill.code === 3 && has(verifyStill.lines, "REFUND_VERIFY: PENDING") && snapshot(still.dir) === beforeStill);
}

{
  const info = await plan();
  const stopped = await run({
    argv: sendArgv(info),
    onQuote: (dir) => writeFileSync(join(dir, "STOP"), "already\n"),
  });
  check("T19 an exclusive STOP failure publishes nothing", stopped.code === 2 && stopped.counts.publish === 0 && has(stopped.lines, "STOP already exists"));
  let sys = 0;
  const active = await run({
    argv: sendArgv(info),
    systemctl: () => {
      sys += 1;
      return sys === 1 ? "inactive" : "active";
    },
  });
  check("T19 a runner that starts after the first check is refused", active.code === 2 && active.counts.publish === 0 && existsSync(join(active.dir, "STOP")) && !existsSync(join(active.dir, "refund", "intent.json")));
  let procs = 0;
  const running = await run({
    argv: sendArgv(info),
    processes: () => {
      procs += 1;
      return procs === 1 ? [] : [{ argv: ["node", "run.mjs"], cwd: "/opt/koreminer" }];
    },
  });
  check("T19 a runner process that appears is refused", running.code === 2 && running.counts.publish === 0 && existsSync(join(running.dir, "STOP")) && !existsSync(join(running.dir, "refund", "intent.json")));
  const pend = await run({
    argv: sendArgv(info),
    onPending: (n, live) => (n === 1 ? null : { hash: hashOf("LATE") }),
  });
  check("T19 a pending block on the recheck is refused", pend.code === 2 && pend.counts.publish === 0 && !existsSync(join(pend.dir, "refund", "intent.json")) && existsSync(join(pend.dir, "STOP")));
  const moved = await run({
    argv: sendArgv(info),
    onBalance: (n, live) => (n === 1 ? live.balance : live.balance + 1n),
  });
  check("T19 a balance move on the recheck is refused", moved.code === 2 && moved.counts.publish === 0 && !existsSync(join(moved.dir, "refund", "intent.json")));
  let seen = false;
  const ordered = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      const body = JSON.parse(readFileSync(join(ctx.dir, "refund", "intent.json"), "utf8"));
      seen = body.block === ctx.blockHash;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  check("T19 the intent is sealed before publish", seen && ordered.counts.publish === 1);
}

{
  const info = await plan();
  const rawTotal = BigInt(info.total.replace(".", ""));
  const landed = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const backup = readdirSync(landed.dir).find((name) => name.startsWith("books.json.pre-refund-"));
  const original = JSON.parse(readFileSync(join(landed.dir, backup), "utf8"));
  original.operator = (BigInt(original.operator) + 1n).toString();
  rmSync(join(landed.dir, "refund", "done.json"));
  rmSync(join(landed.dir, backup));
  const tampered = `${JSON.stringify(original)}\n`;
  writeFileSync(landed.booksPath, tampered);
  const verified = await landed.again(["--verify"]);
  check("T20 a books mismatch is not written", verified.code === 3 && has(verified.lines, "BOOKS_MISMATCH") && readFileSync(landed.booksPath, "utf8") === tampered);
  check("T20 no pre-refund backup is written", !readdirSync(landed.dir).some((name) => name.startsWith("books.json.pre-refund-")));
  const fresh = await run({
    argv: sendArgv(info),
    onPublish: (_b, _o, ctx) => {
      ctx.live.history = [staple(ctx.blockHash, FEE), ...oldHistory()];
      ctx.live.balance -= rawTotal + FEE;
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(ctx.blockHash) }] } };
    },
  });
  const adjusted = booksFromJson(JSON.parse(readFileSync(fresh.booksPath, "utf8")));
  const lots = new Map();
  for (const lot of adjusted.share.lots) lots.set(lot.from, (lots.get(lot.from) ?? 0n) + BigInt(lot.remaining));
  let lotsOk = true;
  for (const [key, amount] of adjusted.share.stake) if (amount !== (lots.get(key) ?? 0n)) lotsOk = false;
  for (const key of lots.keys()) if ((adjusted.share.stake.get(key) ?? 0n) !== lots.get(key)) lotsOk = false;
  const kept = [...adjusted.share.stake.keys(), ...adjusted.share.lots.map((lot) => lot.from)];
  check("T20 remaining lots match stake and refunded keys are gone", lotsOk && accounted(adjusted) === fresh.live.balance && kept.every((key) => !EXCLUDED.has(key) && !Object.keys(EXPECT).some((prefix) => key.includes(prefix))));
}

function writeDrain(mutator) {
  const body = JSON.parse(readFileSync(DRAIN, "utf8"));
  mutator(body);
  const path = join(mkdtempSync(join(tmpdir(), "kore-drain-")), "refund-drain.json");
  writeFileSync(path, JSON.stringify(body));
  return { path, sha: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
{
  const spaced = readFileSync(DRAIN, "utf8") + " ";
  const shaPath = join(mkdtempSync(join(tmpdir(), "kore-drain-")), "refund-drain.json");
  writeFileSync(shaPath, spaced);
  const shaBad = await run({ argv: ["--no-quote"], drainPath: shaPath });
  check("T21 a changed sha is refused", shaBad.code === 2 && has(shaBad.lines, "drain file hash does not match"));
  const cases = [
    ["extra key", (body) => body.weights.push({ key: "keeta_aab6z3pj5ywg75f725a3kdyiawwvsupsgcjzukjmjy2ybpqriqdt4a5sks4ocuq", weight: "1" }), "drain weights are not the pinned set"],
    ["missing key", (body) => body.weights.pop(), "drain weights are not the pinned set"],
    ["duplicate key", (body) => { body.weights[1].key = body.weights[0].key; }, "drain weights are not the pinned set"],
    ["zero weight", (body) => { body.weights[9].weight = "0"; }, "drain weight is invalid"],
    ["negative weight", (body) => { body.weights[9].weight = "-1"; }, "drain weight is invalid"],
    ["19 dp", (body) => { body.weights[9].weight = "1.0000000000000000001"; }, "drain weight is invalid"],
    ["sum differs", (body) => { body.weights[9].weight = "2"; }, "drain total does not match"],
    ["total differs", (body) => { body.total = "4716"; }, "drain total does not match"],
    ["excluded key", (body) => { body.weights[9].key = TREY_A; }, "drain key is excluded"],
  ];
  for (const [name, mutator, message] of cases) {
    const file = writeDrain(mutator);
    const result = await run({ argv: ["--no-quote"], drainPath: file.path, drainSha: file.sha });
    check(`T21 ${name} is refused`, result.code === 2 && has(result.lines, message));
  }
}

for (const fault of ["excluded", "zero", "total"]) {
  const result = await run({ argv: ["--no-quote"], plannerFault: fault });
  check(`T22 ${fault} is refused before building`, result.code === 2 && result.counts.init === 0 && has(result.lines, "plan assertion failed"));
}

{
  const quiet = await run({ argv: ["--no-quote"], trackReads: true });
  check("T23 no-quote does not build sign or quote", quiet.code === 0 && quiet.counts.init === 0 && quiet.counts.builds === 0 && quiet.counts.quotes === 0 && quiet.counts.seed === 0);
  check("T23 no-quote never opens the seed", !quiet.opened.some((path) => path.endsWith("seed.txt")));
  check("T23 no-quote prints the plan", has(quiet.lines, "PLAN ") && has(quiet.lines, "REFUND_DRY_RUN_OK (no quote)") && rowsOf(quiet));
}

function rowsOf(result) {
  return parseRows(result.lines).length === 14;
}

{
  const none = await run({ argv: [] });
  check("T24 pending after quote is none", none.code === 0 && has(none.lines, "Pending block after quote: none"));
  const late = await run({
    argv: [],
    onPending: (n) => (n === 1 ? null : { hash: hashOf("AFTER") }),
  });
  check("T24 a pending block after the quote is reported", late.code === 0 && has(late.lines, "Pending block after quote: AFTER") && has(late.lines, "REFUND_CHECK: pending block after quote"));
}

{
  const first = await run({ argv: ["--no-quote"] });
  const second = await run({ argv: ["--no-quote"] });
  const digest = grab(first.lines, "PLAN ");
  check("T25 the plan digest is stable", digest === grab(second.lines, "PLAN ") && /^[0-9a-f]{64}$/.test(digest));
  const local = parseRows(first.lines).map((row) => `${row.key}:${row.raw}`).sort();
  const own = createHash("sha256").update(local.join("\n")).digest("hex");
  check("T25 the digest is the sorted raw lines", own === digest);
  local[0] = `${local[0].slice(0, local[0].lastIndexOf(":") + 1)}${BigInt(local[0].split(":")[1]) + 1n}`;
  const changed = createHash("sha256").update(local.sort().join("\n")).digest("hex");
  check("T25 one raw unit changes the digest", changed !== digest);
  const info = await plan();
  const refused = await run({ argv: sendArgv(info, { plan: changed }) });
  check("T25 an old digest is refused", refused.code === 2 && refused.counts.publish === 0 && has(refused.lines, "confirm plan does not match"));
}

{
  const cases = [
    [["node", "run.mjs"], "/opt/koreminer", true],
    [["/usr/bin/node", "/opt/koreminer/run.mjs"], "/", true],
    [["node", "./run.mjs"], "/opt/koreminer", true],
    [["node", "/home/x/run.mjs"], "/home/x", false],
    [["node", "refund.mjs"], "/opt/koreminer", false],
  ];
  for (const [argv, cwd, refuse] of cases) {
    const result = await run({ argv: ["--no-quote"], processes: () => [{ argv, cwd }] });
    check(`T26 ${argv.join(" ")} cwd ${cwd}`, refuse ? result.code === 2 && has(result.lines, "run.mjs is running") : result.code === 0);
  }
}

const none = await run({ argv: ["--verify"] });
check("verify with no intent exits quietly", none.code === 0 && has(none.lines, "REFUND_VERIFY: no intent") && none.counts.seed === 0);

console.log(`refund checks ${passed}`);
