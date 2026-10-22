// Canary route checks: --batch 1 (the 4.75 KTA canary), --check, --batch 2 (the other 13).
// Drives the real main() with a fake chain that keeps landed staples, so batch 2 sees batch 1.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, openSync as fsOpen, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { accounted, booksFromJson, ingest, reconcile } from "./books.mjs";
import { accrue } from "./share.mjs";
import { DAY_MS, dayBudget } from "./ledger.mjs";
import { main, MEMO, INTAKE, REFUND_FEE_CAP } from "./refund.mjs";

const RAW = 10n ** 18n;
const BASE = { id: "kta" };
const FIXTURE = new URL("./refund-fixture-books.json", import.meta.url);
const CANARY = "keeta_aabrmmctfikuanrdtlimnedov5bcshc2hmyrjlvqy5h2cvfwntlrkp6cquzakja";
const ZERO = "keeta_aabdkkc2fkbj2opullbe34ohrrzdeej3mkx4szevk42mkhz6yfmmi5iupcdsvca";
const BIG = "keeta_aabd7qpxd6li6qwkyr4qjlzao7fu6wadr6pwhekxmem2iqtsb27wn5yphdqyv5y";
const CUJP = "keeta_aab3cujp6bgzzzbacn3eyslyzt432cnqs3zbc4mbqqwcpgywfeaomtasbbyvdmi";
const TREY_A = "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i";
const TREY_B = "keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy";
const BRIDGE = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const NEWBIE = "keeta_aabnewminerxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const FEE = 4n * 10n ** 15n;
const SUITE = mkdtempSync(join(tmpdir(), "kore-batch-suite-"));
process.on("exit", () => {
  if (dirname(SUITE) === tmpdir() && basename(SUITE).startsWith("kore-batch-suite-")) rmSync(SUITE, { recursive: true, force: true });
});

let passed = 0;
function check(name, ok) {
  if (!ok) throw new Error(name);
  passed += 1;
  console.log("ok", name);
}
const has = (lines, text) => lines.some((line) => line.includes(text));
const grab = (lines, prefix) => {
  const line = lines.find((item) => item.startsWith(prefix));
  if (!line) throw new Error(`missing ${prefix}`);
  return line.slice(prefix.length);
};
const hex = (text) => createHash("sha256").update(text).digest("hex").toUpperCase();
const hashOf = (text) => ({ toString: () => text });

function snapshot(dir, skip = () => false) {
  const rows = [];
  (function walk(path) {
    const st = statSync(path);
    if (skip(path)) return;
    rows.push(`${path}:${st.isDirectory() ? "d" : createHash("sha256").update(readFileSync(path)).digest("hex")}:${st.mode}`);
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  })(dir);
  return rows.join("\n");
}

function world(opts = {}) {
  const dir = mkdtempSync(join(SUITE, "w-"));
  writeFileSync(join(dir, "books.json"), opts.booksText ?? readFileSync(FIXTURE));
  const books = booksFromJson(JSON.parse(readFileSync(join(dir, "books.json"), "utf8")));
  const old = { voteStaple: { timestamp: () => new Date("2026-10-01T00:00:00.000Z"), blocksHash: hashOf("OLD"), blocks: [] } };
  const w = {
    dir,
    balance: accounted(books),
    pending: null,
    history: [old],
    landing: "land",
    counts: { publish: 0, quotes: 0, builds: 0, seed: 0 },
    serial: 0,
    published: [],
  };
  const client = {
    async balance() { return w.balance; },
    async pendingBlock() { return w.pending; },
    async getHistory() { return w.history; },
    async getQuotes() { w.counts.quotes += 1; return [0, 1, 2, 3].map(() => ({ fee: { amount: 10n ** 15n, token: BASE } })); },
    initBuilder() {
      const sends = [];
      return {
        send(to, amount, token, external) { sends.push({ to, amount, token, external }); },
        async computeBlocks() {
          w.counts.builds += 1;
          w.serial += 1;
          const hash = hex(`block-${w.serial}`);
          const operations = sends.map((row) => ({ type: 0, to: row.to, token: row.token, amount: row.amount, external: row.external }));
          w.lastBlock = { hash: hashOf(hash), account: INTAKE, operations };
          return { blocks: [w.lastBlock] };
        },
        async computeFeeBlock(staple) {
          let kta = 0n;
          for (const vote of staple?.votes ?? []) kta += vote?.fee?.amount ?? 0n;
          return { operations: [{ type: 0, token: BASE, amount: kta }] };
        },
      };
    },
    async publishBuilder(_builder, options) {
      w.counts.publish += 1;
      const block = w.lastBlock;
      const staple = { votes: (options?.quotes ?? []).map((q) => ({ fee: q.fee })), blocks: [block] };
      await options.generateFeeBlock(staple, options);
      const hash = block.hash.toString();
      w.published.push(block);
      if (w.landing === "throw") throw new Error("timeout");
      if (w.landing === "land") {
        let total = 0n;
        for (const op of block.operations) total += op.amount;
        const land = opts.landAt?.[w.published.length - 1];
        const at = land === "invalid" ? new Date(Number.NaN) : new Date(land ?? "2026-10-25T14:00:00.000Z");
        w.history = [{
          voteStaple: {
            ...(land === "missing" ? {} : { timestamp: () => at }),
            blocksHash: hashOf(`STAPLE-${hash.slice(0, 8)}`),
            blocks: [block, { account: INTAKE, hash: hashOf(`FEE-${hash.slice(0, 8)}`), operations: [{ type: 0, amount: FEE, token: BASE, to: "fee" }] }],
          },
        }, ...w.history];
        w.balance -= total + FEE;
      }
      return { from: "direct", voteStaple: { blocks: [{ hash: hashOf(hash) }] } };
    },
    async send() { throw new Error("send"); },
    async recover() { throw new Error("recover"); },
  };
  w.go = async (argv, extra = {}) => {
    const lines = [];
    const code = await main({
      dir,
      now: () => opts.nowMs ?? Date.parse("2026-10-25T14:00:00.000Z"),
      systemctl: () => "inactive",
      processes: () => [],
      loadWallet: () => { w.counts.seed += 1; return { publicKeyString: INTAKE }; },
      accountFrom: (id) => ({ publicKeyString: id }),
      base: BASE,
      baseText: "kta",
      client,
      uid: 0,
      ...extra,
      argv,
      output: (line) => lines.push(line),
    });
    return { code, lines };
  };
  w.books = () => booksFromJson(JSON.parse(readFileSync(join(dir, "books.json"), "utf8")));
  w.rmStop = () => { if (existsSync(join(dir, "STOP"))) rmSync(join(dir, "STOP")); };
  w.path = (...parts) => join(dir, ...parts);
  w.json = (...parts) => JSON.parse(readFileSync(join(dir, ...parts), "utf8"));
  return w;
}

function info(lines) {
  return { total: grab(lines, "TOTAL "), n: grab(lines, "N "), plan: grab(lines, "PLAN "), full: grab(lines, "FULLPLAN ") };
}
function sendArgv(batch, i, over = {}) {
  return ["--send", "--batch", batch, "--confirm-total", over.total ?? i.total, "--confirm-count", over.n ?? i.n, "--confirm-plan", over.plan ?? i.plan, ...(over.noFull ? [] : ["--confirm-full", over.full ?? i.full])];
}
function rows(lines) {
  return lines.filter((line) => /^\d+ keeta_/.test(line)).map((line) => {
    const m = line.match(/^\d+ (keeta_[a-z0-9]+) stake (\S+) weight (\S+) addback (\S+) total (\S+) raw (\d+)$/);
    return { key: m[1], stake: m[2], addback: m[4], total: m[5], raw: BigInt(m[6]) };
  });
}
function opsOnChain(w) {
  const out = [];
  for (const row of w.history) for (const block of row.voteStaple.blocks) for (const op of block.operations ?? []) {
    if (op.external === MEMO) out.push({ block: block.hash.toString(), to: op.to.publicKeyString ?? op.to, amount: op.amount });
  }
  return out;
}

// Runs batch 1, its check, then batch 2 dry run. Returns everything for later steps.
async function throughB1(w) {
  const d1 = await w.go(["--no-quote", "--batch", "1"]);
  const i1 = info(d1.lines);
  const s1 = await w.go(sendArgv("1", i1));
  const c1 = await w.go(["--check", "--batch", "1"]);
  w.rmStop();
  return { d1, i1, s1, c1 };
}
async function throughB2(w) {
  const r = await throughB1(w);
  const d2 = await w.go(["--no-quote", "--batch", "2"]);
  const i2 = info(d2.lines);
  const s2 = await w.go(sendArgv("2", i2));
  const c2 = await w.go(["--check", "--batch", "2"]);
  return { ...r, d2, i2, s2, c2 };
}

const fixtureBooks = booksFromJson(JSON.parse(readFileSync(FIXTURE, "utf8")));
const POOL = fixtureBooks.share.stake.get(TREY_A) + fixtureBooks.share.stake.get(TREY_B) + fixtureBooks.share.stake.get(BRIDGE) - REFUND_FEE_CAP;
const CANARY_ADD = (POOL * 13n * RAW) / (4715n * RAW);

// ---- the batch flag
{
  const w = world();
  for (const argv of [["--no-quote"], [], ["--verify"], ["--check"], ["--send"], ["--no-quote", "--batch", "3"], ["--no-quote", "--batch"]]) {
    const r = await w.go(argv);
    check(`BF batch flag required: ${argv.join(" ") || "(dry run)"}`, r.code === 2 && has(r.lines, "REFUND_REFUSED: batch flag is missing or invalid") && w.counts.quotes === 0 && w.counts.seed === 0);
  }
}

// ---- happy path
const legacy = world();
const all = await legacy.go(["--no-quote", "--batch", "all"]);
const allInfo = { total: grab(all.lines, "TOTAL "), plan: grab(all.lines, "PLAN "), rows: rows(all.lines) };
const hp = world();
const run = await throughB2(hp);
{
  const r1 = rows(run.d1.lines);
  check("B1 batch 1 is the canary only", run.d1.code === 0 && r1.length === 1 && r1[0].key === CANARY && run.i1.n === "1");
  check("B1 canary amount is its add-back from Trey's share (4.750445)", r1[0].raw === CANARY_ADD && r1[0].total === "4.750445" && r1[0].stake === "0.000000");
  check("B1 full plan is the reviewed 14-row plan", run.i1.full === allInfo.plan && grab(run.d1.lines, "FULL N ") === `14 TOTAL ${allInfo.total}`);
  check("B1 aabdkkc2 and Trey's keys are in no batch", !allInfo.rows.some((r) => r.key === ZERO || r.key === TREY_A || r.key === TREY_B || r.key === BRIDGE) && !has(run.d1.lines.filter((l) => /^\d+ /.test(l)), ZERO));
  const preview = grab(run.d1.lines, "NEXT BATCH 2 ");
  check("B1 preview of batch 2 is the other 13", preview.startsWith("N 13 TOTAL "));
  const fresh = world();
  const booksBefore = readFileSync(fresh.path("books.json"));
  const nq = await fresh.go(["--no-quote", "--batch", "1"]);
  const seedAfterNq = fresh.counts.seed;
  const qd = await fresh.go(["--batch", "1"]);
  check("B1 dry runs publish nothing; only the quoted one loads the seed", nq.code === 0 && qd.code === 0 && has(qd.lines, "Pending block after quote: none") && seedAfterNq === 0 && fresh.counts.seed === 1 && fresh.published.length === 0 && !existsSync(fresh.path("STOP")) && !existsSync(fresh.path("refund", "wallets")) && !existsSync(fresh.path("refund", "plan.json")) && readFileSync(fresh.path("books.json")).equals(booksBefore));
  check("B2 batch 1 send lands and books", run.s1.code === 0 && has(run.s1.lines, "REFUND_SENT_OK") && has(run.s1.lines, "BOOKS_OK") && hp.published[0].operations.length === 1 && hp.published[0].operations[0].to.publicKeyString === CANARY && hp.published[0].operations[0].amount === CANARY_ADD && hp.published[0].operations[0].external === MEMO);
  check("B2 batch 1 files: plan, record, intent, done, receipt", existsSync(hp.path("refund", "plan.json")) && existsSync(hp.path("refund", "wallets", `${CANARY}.json`)) && existsSync(hp.path("refund", "b1", "intent.json")) && hp.json("refund", "b1", "done.json").books === "adjusted" && readdirSync(hp.path("refund", "b1")).some((n) => n.startsWith("receipt-")) && !existsSync(hp.path("refund", "intent.json")));
  check("B2 frozen plan digest is the full plan", hp.json("refund", "plan.json").fullPlan === run.i1.full && hp.json("refund", "b1", "intent.json").fullPlan === run.i1.full);
  check("B3 check 1 verifies batch 1", run.c1.code === 0 && has(run.c1.lines, "REFUND_BATCH_VERIFIED 1 ") && has(run.c1.lines, `PAID ${CANARY} 4.750445`) && has(run.c1.lines, "FEE 0.004000000000000000") && existsSync(hp.path("refund", "b1", "verified.json")));
  const r2 = rows(run.d2.lines);
  check("B4 batch 2 dry run is the other 13, no canary", run.d2.code === 0 && r2.length === 13 && !r2.some((r) => r.key === CANARY) && run.i2.n === "13");
  check("B4 batch 2 matches the batch 1 preview", grab(run.d1.lines, "NEXT BATCH 2 ") === `N 13 TOTAL ${run.i2.total} PLAN ${run.i2.plan}` && run.i2.full === run.i1.full);
  check("B5 batch 2 send lands and books", run.s2.code === 0 && has(run.s2.lines, "REFUND_SENT_OK") && hp.published[1].operations.length === 13 && !hp.published[1].operations.some((op) => op.to.publicKeyString === CANARY));
  const chainOps = opsOnChain(hp);
  check("B5 each of the 14 wallets is paid exactly once on chain", chainOps.length === 14 && new Set(chainOps.map((o) => o.to)).size === 14);
  const total1 = BigInt(run.i1.total.replace(".", ""));
  const total2 = BigInt(run.i2.total.replace(".", ""));
  check("B5 batch totals add up to the single-block total", total1 + total2 === BigInt(allInfo.total.replace(".", "")));
  const b = hp.books();
  const allKeys = allInfo.rows.map((r) => r.key);
  check("B5 books: every refunded and excluded key is zero", [...allKeys, TREY_A, TREY_B, BRIDGE].every((k) => (b.share.stake.get(k) ?? 0n) === 0n && !b.share.lots.some((l) => l.from === k)));
  check("B5 books equal chain and operator is the expected remainder", accounted(b) === hp.balance && b.operator === fixtureBooks.operator + REFUND_FEE_CAP + (POOL - [...allInfo.rows].reduce((s, r) => s + BigInt(r.raw) - BigInt(r.stake.replace(".", "")) * 10n ** 12n, 0n)) - 2n * FEE);
  check("B6 check 2 verifies both batches", run.c2.code === 0 && has(run.c2.lines, "REFUND_BATCH_VERIFIED 2 ") && has(run.c2.lines, "REFUND_SENDS_ON_CHAIN 14"));
  const shot = snapshot(hp.dir);
  const again = await hp.go(["--check", "--batch", "2"]);
  check("B6 a second check is a no-op", again.code === 0 && has(again.lines, "already verified, marker unchanged") && snapshot(hp.dir) === shot);
  const seedBefore = hp.counts.seed;
  const quotesBefore = hp.counts.quotes;
  await hp.go(["--check", "--batch", "1"]);
  check("B6 check never loads the seed, quotes or builds", hp.counts.seed === seedBefore && hp.counts.quotes === quotesBefore && hp.published.length === 2);
  hp.rmStop();
  const rerun2 = await hp.go(sendArgv("2", run.i2));
  const rerun1 = await hp.go(sendArgv("1", run.i1));
  const rerunAll = await hp.go(["--send", "--batch", "all", "--confirm-total", allInfo.total, "--confirm-count", "14", "--confirm-plan", allInfo.plan]);
  check("B7 rerunning any batch after the refund is refused, nothing published", rerun2.code === 2 && rerun1.code === 2 && rerunAll.code === 2 && hp.published.length === 2);
}

// ---- batch 2 guards
async function readyForB2(mutate) {
  const w = world();
  const r = await throughB1(w);
  if (mutate) await mutate(w, r);
  const d2 = await w.go(["--no-quote", "--batch", "2"]);
  return { w, r, d2 };
}
function refusedWith(res, text) {
  return res.code === 2 && has(res.lines, `REFUND_REFUSED: ${text}`);
}
{
  const w = world();
  const r = await throughB1(w);
  rmSync(w.path("refund", "b1", "verified.json"));
  const d2 = await w.go(["--no-quote", "--batch", "2"]);
  check("W-b1-verified batch 2 before check 1 is refused", refusedWith(d2, "batch 1 is not verified"));
  const w0 = world();
  const early = await w0.go(["--no-quote", "--batch", "2"]);
  check("W-b1 batch 2 before batch 1 is refused", refusedWith(early, "batch 1 has not been sent"));
  void r;
}
check("W-b1-done batch 1 books not adjusted", refusedWith((await readyForB2((w) => { const d = w.json("refund", "b1", "done.json"); d.books = "mismatch"; writeFileSync(w.path("refund", "b1", "done.json"), JSON.stringify(d)); })).d2, "batch 1 books are not adjusted"));
check("W-b1-intent batch 1 intent not the canary", refusedWith((await readyForB2((w) => { const d = w.json("refund", "b1", "intent.json"); d.recipients[0].key = BIG; writeFileSync(w.path("refund", "b1", "intent.json"), JSON.stringify(d)); })).d2, "batch 1 intent is not the canary"));
check("W-plan tampered frozen plan", refusedWith((await readyForB2((w) => { const d = w.json("refund", "plan.json"); d.rows[0].amount = (BigInt(d.rows[0].amount) + 1n).toString(); d.rows[0].stake = (BigInt(d.rows[0].stake) + 1n).toString(); writeFileSync(w.path("refund", "plan.json"), JSON.stringify(d)); })).d2, "frozen plan does not match"));
check("W-b1-marker tampered verify marker", refusedWith((await readyForB2((w) => { const d = w.json("refund", "b1", "verified.json"); d.intentSha = "0".repeat(64); writeFileSync(w.path("refund", "b1", "verified.json"), JSON.stringify(d)); })).d2, "batch 1 verify marker does not match"));
check("W-rec-set an extra wallet record", refusedWith((await readyForB2((w) => { writeFileSync(w.path("refund", "wallets", `${BIG}.json`), JSON.stringify({ key: BIG, batch: "2", block: "X", amount: "1" })); })).d2, "wallet records are not batch 1 only (2)"));
check("W-rec-set the canary record missing", refusedWith((await readyForB2((w) => { rmSync(w.path("refund", "wallets", `${CANARY}.json`)); })).d2, "wallet records are not batch 1 only (0)"));
check("W-rec-block canary record for another block", refusedWith((await readyForB2((w) => { const p = w.path("refund", "wallets", `${CANARY}.json`); const d = JSON.parse(readFileSync(p, "utf8")); d.block = "F".repeat(64); writeFileSync(p, JSON.stringify(d)); })).d2, "batch 1 wallet record does not match"));
check("W-rec-read a stray file in refund/wallets", refusedWith((await readyForB2((w) => { writeFileSync(w.path("refund", "wallets", "notes.txt"), "x"); })).d2, "unexpected file in refund/wallets"));
check("W-rec-read an unreadable record", refusedWith((await readyForB2((w) => { writeFileSync(w.path("refund", "wallets", `${BIG}.json`), "{"); })).d2, "wallet record is unreadable"));
check("W-chain-b1 batch 1 not on chain", refusedWith((await readyForB2((w) => { w.history = w.history.slice(1); })).d2, "batch 1 is not on chain"));
function addMemo(w, to, amount) {
  w.history = [{ voteStaple: { timestamp: () => new Date("2026-10-24T14:00:00.000Z"), blocksHash: hashOf("MANUAL"), blocks: [{ account: INTAKE, hash: hashOf(hex("manual")), operations: [{ type: 0, to: { publicKeyString: to }, amount, token: BASE, external: MEMO }] }] } }, ...w.history];
}
check("W-chain-overlap a planned wallet already refunded on chain", refusedWith((await readyForB2((w) => addMemo(w, BIG, 5n))).d2, "a selected wallet already has a refund on chain"));
check("W-chain-extra an unexpected refund memo on chain", refusedWith((await readyForB2((w) => addMemo(w, TREY_A, 5n))).d2, "unexpected refund memo on chain"));
function editBooks(w, fn) {
  const raw = JSON.parse(readFileSync(w.path("books.json"), "utf8"));
  const delta = fn(raw) ?? 0n;
  writeFileSync(w.path("books.json"), JSON.stringify(raw));
  w.balance += delta;
}
check("W-unplanned new stake on an unplanned wallet", refusedWith((await readyForB2((w) => editBooks(w, (raw) => { raw.stake[NEWBIE] = RAW.toString(); raw.lots.push({ from: NEWBIE, remaining: RAW.toString() }); return RAW; }))).d2, "unplanned stake on"));
check("W-excluded-zero Trey's key has stake again", refusedWith((await readyForB2((w) => editBooks(w, (raw) => { raw.stake[TREY_A] = RAW.toString(); raw.lots.push({ from: TREY_A, remaining: RAW.toString() }); return RAW; }))).d2, "excluded stake is not zero after batch 1"));
check("W-stake-grew a planned wallet's stake grew", refusedWith((await readyForB2((w) => editBooks(w, (raw) => { raw.stake[BIG] = (BigInt(raw.stake[BIG]) + 1n).toString(); raw.lots.find((l) => l.from === BIG).remaining = raw.stake[BIG]; return 1n; }))).d2, "stake grew since the plan on"));
check("W-operator batch 2 would leave operator negative", refusedWith((await readyForB2((w) => editBooks(w, (raw) => { const move = BigInt(raw.operator) - 10n ** 17n; raw.operator = (10n ** 17n).toString(); raw.parked = (BigInt(raw.parked ?? "0") + move).toString(); return 0n; }))).d2, "operator would go negative"));
{
  const w = world();
  editBooks(w, (raw) => { const move = BigInt(raw.operator) + 2000n * RAW; raw.operator = (BigInt(raw.operator) - move).toString(); raw.parked = (BigInt(raw.parked ?? "0") + move).toString(); return 0n; });
  const d = await w.go(["--no-quote", "--batch", "1"]);
  const q = await w.go(["--batch", "1"]);
  check("W-operator batch 1 would leave operator negative (no-quote and quoted)", refusedWith(d, "operator would go negative") && refusedWith(q, "operator would go negative") && w.published.length === 0);
}
{
  const { w, d2 } = await readyForB2((w) => editBooks(w, (raw) => {
    // a nightly payout fee burned from the oldest lot (aab3cujp) after batch 1
    raw.stake[CUJP] = (BigInt(raw.stake[CUJP]) - FEE).toString();
    raw.lots.find((l) => l.from === CUJP).remaining = raw.stake[CUJP];
    return -FEE;
  }));
  const r = rows(d2.lines).find((x) => x.key === CUJP);
  const i2 = info(d2.lines);
  const s2 = await w.go(sendArgv("2", i2));
  const c2 = await w.go(["--check", "--batch", "2"]);
  check("W-drift a payout-fee burn after batch 1 pays the live unburned stake", d2.code === 0 && r.stake !== "0.000000" && s2.code === 0 && has(s2.lines, "BOOKS_OK") && c2.code === 0 && accounted(w.books()) === w.balance);
}

// ---- state and record guards
{
  const w = world();
  mkdirSync(w.path("refund"), { recursive: true });
  writeFileSync(w.path("refund", "intent.json"), JSON.stringify({ block: "L", total: "1" }));
  check("W-state batch 1 with a legacy intent is refused", refusedWith(await w.go(["--no-quote", "--batch", "1"]), "refund files from another batch are present"));
  const w2 = world();
  mkdirSync(w2.path("refund"), { recursive: true });
  writeFileSync(w2.path("refund", "plan.json"), "{}");
  check("W-state batch all with a batch plan is refused", refusedWith(await w2.go(["--no-quote", "--batch", "all"]), "refund files from another batch are present"));
  const { w: w3 } = await readyForB2();
  writeFileSync(w3.path("refund", "done.json"), JSON.stringify({ block: "L" }));
  check("W-state batch 2 with a legacy done is refused", refusedWith(await w3.go(["--no-quote", "--batch", "2"]), "refund files from another batch are present"));
  const w4 = world();
  mkdirSync(w4.path("refund", "wallets"), { recursive: true, mode: 0o700 });
  writeFileSync(w4.path("refund", "wallets", `${CANARY}.json`), JSON.stringify({ key: CANARY }));
  check("W-rec-empty batch 1 with a wallet record is refused", refusedWith(await w4.go(["--no-quote", "--batch", "1"]), "wallet records are present (1)"));
  check("W-rec-empty batch all with a wallet record is refused", refusedWith(await w4.go(["--no-quote", "--batch", "all"]), "wallet records are present (1)") && w4.counts.quotes === 0);
}

// ---- confirms
{
  const w = world();
  const d1 = await w.go(["--no-quote", "--batch", "1"]);
  const i1 = info(d1.lines);
  const wrong = await w.go(sendArgv("1", i1, { full: `${i1.full.slice(0, -1)}0` }));
  const missing = await w.go(sendArgv("1", i1, { noFull: true }));
  const wrongPlan = await w.go(sendArgv("1", i1, { plan: allInfo.plan }));
  check("W-confirm-full batch 1 wrong or missing full plan is refused", refusedWith(wrong, "confirm full plan does not match") && refusedWith(missing, "confirm flags are missing") && refusedWith(wrongPlan, "confirm plan does not match") && w.published.length === 0 && !existsSync(w.path("STOP")));
  const { w: w2, d2 } = await readyForB2();
  const i2 = info(d2.lines);
  const wrong2 = await w2.go(sendArgv("2", i2, { full: allInfo.plan.replace(/.$/, "0") }));
  check("W-confirm-full batch 2 wrong full plan is refused", refusedWith(wrong2, "confirm full plan does not match") && w2.published.length === 1);
}

// ---- never twice: crash, rerun and unknown results
{
  const w = world();
  const d1 = await w.go(["--no-quote", "--batch", "1"]);
  const i1 = info(d1.lines);
  w.landing = "throw";
  const s1 = await w.go(sendArgv("1", i1));
  check("W-rec-write batch 1 unknown result keeps a record and an intent", s1.code === 3 && has(s1.lines, "REFUND_HOLD: publish error") && existsSync(w.path("refund", "wallets", `${CANARY}.json`)) && existsSync(w.path("refund", "b1", "intent.json")));
  w.rmStop();
  w.landing = "land";
  const again = await w.go(sendArgv("1", i1));
  check("W-rec-write batch 1 rerun after an unknown result is refused", refusedWith(again, "prior refund intent") && w.published.length === 1);
  renameSync(w.path("refund", "b1", "intent.json"), w.path("refund", "b1", "intent.void.json"));
  renameSync(w.path("refund", "plan.json"), w.path("refund", "plan.void.json"));
  const voided = await w.go(sendArgv("1", i1));
  check("W-rec-write batch 1 rerun with intent and plan moved aside is still refused by the record", refusedWith(voided, "wallet records are present (1)"));
  check("W-rec-write no second publish for batch 1", w.published.length === 1);
}
{
  // batch 1 lands; then a crash between the records and the batch 2 intent
  const { w: w2, d2 } = await readyForB2();
  const i2 = info(d2.lines);
  const crash = await w2.go(sendArgv("2", i2), {
    fs: {
      openSync: (path, flags, mode) => {
        if (String(path).endsWith("/b2/intent.json.tmp")) throw Object.assign(new Error("disk"), { code: "EIO" });
        return fsOpen(path, flags, mode);
      },
    },
  });
  check("W-rec-write crash after records, before the batch 2 intent: no publish", crash.code === 3 && w2.published.length === 1 && readdirSync(w2.path("refund", "wallets")).length === 14 && !existsSync(w2.path("refund", "b2", "intent.json")));
  w2.rmStop();
  const rerun = await w2.go(sendArgv("2", i2));
  check("W-rec-write batch 2 rerun after that crash is refused by the records", refusedWith(rerun, "wallet records are not batch 1 only (14)") && w2.published.length === 1);
}
{
  const { w, d2 } = await readyForB2();
  const i2 = info(d2.lines);
  w.landing = "throw";
  const s2 = await w.go(sendArgv("2", i2));
  w.rmStop();
  w.landing = "land";
  const verify = await w.go(["--verify", "--batch", "2"]);
  renameSync(w.path("refund", "b2", "intent.json"), w.path("refund", "b2", "intent.void.json"));
  const rerun = await w.go(sendArgv("2", i2));
  check("W-rec-write batch 2 unknown result: verify says not landed, rerun refused by records", s2.code === 3 && verify.code === 3 && has(verify.lines, "REFUND_VERIFY: NOT_LANDED") && refusedWith(rerun, "wallet records are not batch 1 only (14)") && w.published.length === 2);
}
{
  // landed but the process died before FINISH: verify finishes batch 1, then batch 2 works
  const w = world();
  const d1 = await w.go(["--no-quote", "--batch", "1"]);
  const i1 = info(d1.lines);
  const s1 = await w.go(sendArgv("1", i1), {
    fs: {
      openSync: (path, flags, mode) => {
        if (String(path).includes("/b1/receipt-")) throw Object.assign(new Error("died"), { code: "EIO" });
        return fsOpen(path, flags, mode);
      },
    },
  });
  const v = await w.go(["--verify", "--batch", "1"]);
  const c = await w.go(["--check", "--batch", "1"]);
  w.rmStop();
  const d2 = await w.go(["--no-quote", "--batch", "2"]);
  check("W-verify batch 1 landed without FINISH: verify finishes it once, check passes, batch 2 is the 13", s1.code === 3 && v.code === 0 && has(v.lines, "REFUND_VERIFY: LANDED (finished now)") && c.code === 0 && d2.code === 0 && info(d2.lines).n === "13");
}

// ---- check guards
async function landedBoth() {
  const w = world();
  const r = await throughB2(w);
  rmSync(w.path("refund", "b2", "verified.json"));
  return { w, r };
}
const notVerified = (res, text) => res.code === 3 && res.lines.some((line) => line.startsWith("REFUND_BATCH_NOT_VERIFIED: ") && line.includes(text)) && !has(res.lines, "REFUND_BATCH_VERIFIED");
{
  const { w } = await landedBoth();
  const d = w.json("refund", "b2", "done.json"); d.books = "mismatch"; writeFileSync(w.path("refund", "b2", "done.json"), JSON.stringify(d));
  check("C-done books not adjusted", notVerified(await w.go(["--check", "--batch", "2"]), "books are not adjusted for this batch"));
}
{
  const { w } = await landedBoth();
  rmSync(w.path("refund", "b1", "verified.json"));
  check("C-b1-first check 2 needs batch 1 verified", notVerified(await w.go(["--check", "--batch", "2"]), "batch 1 is not verified"));
}
{
  const { w } = await landedBoth();
  const name = readdirSync(w.path("refund", "b2")).find((n) => n.startsWith("receipt-"));
  writeFileSync(w.path("refund", "b2", `receipt-x-${name}`), readFileSync(w.path("refund", "b2", name)));
  check("C-receipt two receipts", notVerified(await w.go(["--check", "--batch", "2"]), "expected exactly one receipt, found 2"));
}
{
  const { w } = await landedBoth();
  w.pending = { hash: hashOf("PEND") };
  check("C-pending a pending block", notVerified(await w.go(["--check", "--batch", "2"]), "a block is pending"));
}
{
  const { w } = await landedBoth();
  const name = readdirSync(w.path("refund", "b2")).find((n) => n.startsWith("receipt-"));
  const d = w.json("refund", "b2", name); d.fee = "5"; writeFileSync(w.path("refund", "b2", name), JSON.stringify(d));
  check("C-fee fee on chain differs from the receipt", notVerified(await w.go(["--check", "--batch", "2"]), "fee on chain"));
}
{
  const { w } = await landedBoth();
  addMemo(w, TREY_B, 1n);
  check("C-ops an extra refund send on chain", notVerified(await w.go(["--check", "--batch", "2"]), "refund sends on chain (15) do not match the sent batches (14)"));
}
{
  const { w } = await landedBoth();
  const intent = w.json("refund", "b2", "intent.json");
  const amount = intent.recipients[0].amount;
  intent.recipients.push({ key: CANARY, amount });
  writeFileSync(w.path("refund", "b2", "intent.json"), JSON.stringify(intent));
  const block = w.history[0].voteStaple.blocks[0];
  block.operations.push({ type: 0, to: { publicKeyString: CANARY }, amount: BigInt(amount), token: BASE, external: MEMO });
  check("C-once a wallet paid twice on chain", notVerified(await w.go(["--check", "--batch", "2"]), "a wallet has more than one refund on chain"));
}
{
  const { w } = await landedBoth();
  w.balance -= 1n;
  check("C-balance balance moved since the receipt", notVerified(await w.go(["--check", "--batch", "2"]), "moved since the receipt"));
}
{
  const { w } = await landedBoth();
  editBooks(w, (raw) => { raw.operator = (BigInt(raw.operator) + 1n).toString(); return 0n; });
  check("C-books-chain books differ from chain", notVerified(await w.go(["--check", "--batch", "2"]), "books "));
}
{
  const { w } = await landedBoth();
  editBooks(w, (raw) => { raw.operator = (BigInt(raw.operator) - RAW).toString(); raw.stake[BIG] = RAW.toString(); raw.lots.push({ from: BIG, remaining: RAW.toString() }); return 0n; });
  check("C-books-zero a refunded wallet still has stake", notVerified(await w.go(["--check", "--batch", "2"]), `books still hold stake for ${BIG}`));
}
{
  const { w } = await landedBoth();
  writeFileSync(w.path("refund", "b2", "verified.json"), "{}\n");
  check("C-marker an existing marker that differs", notVerified(await w.go(["--check", "--batch", "2"]), "verify marker exists and differs"));
}
{
  const { w } = await landedBoth();
  const shot = snapshot(w.dir, (p) => p.endsWith("/b2/verified.json"));
  const books = readFileSync(w.path("books.json"));
  const seed = w.counts.seed;
  const c = await w.go(["--check", "--batch", "2"]);
  check("C-readonly check writes only the marker", c.code === 0 && snapshot(w.dir, (p) => p.endsWith("/b2/verified.json")) === shot && readFileSync(w.path("books.json")).equals(books) && w.counts.seed === seed && (statSync(w.path("refund", "b2", "verified.json")).mode & 0o777) === 0o600);
}

// ---- K1 (KeeLend Ops fix i): KORE earned since the books' last chain block is credited up to each refund block,
// with the stakes as they were before that batch, exactly once; a block at or before lastMs credits nothing.
const sumMap = (m) => [...m.values()].reduce((a, b) => a + b, 0n);
const delta = (after, before) => { const out = new Map(); for (const [k, v] of after) { const d = v - (before.get(k) ?? 0n); if (d !== 0n) out.set(k, d); } for (const k of before.keys()) if (!after.has(k)) out.set(k, -before.get(k)); return out; };
const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const potOf = (fromMs, toMs) => (dayBudget(fromMs) * 1_000_000_000_000n * BigInt(toMs - fromMs)) / BigInt(DAY_MS);
function withLast(ms) { const raw = JSON.parse(readFileSync(FIXTURE, "utf8")); raw.lastMs = ms; return `${JSON.stringify(raw)}\n`; }
const T0 = Date.parse("2026-10-25T00:10:00.000Z"); // Sat 8:10 PM ET, the last chain block before the pause
const T1 = Date.parse("2026-10-25T13:30:00.000Z"); // batch 1 lands
const T2 = Date.parse("2026-10-25T14:30:00.000Z"); // batch 2 lands
const NOW = Date.parse("2026-10-27T12:00:00.000Z"); // r5 (Ops N1): the harness clock is after every K1 landing time
{
  const w = world({ booksText: withLast(T0), landAt: [new Date(T1).toISOString(), new Date(T2).toISOString()], nowMs: NOW });
  const b0 = w.books();
  const r1 = await throughB1(w);
  const b1 = w.books();
  const b1Text = readFileSync(w.path("books.json"), "utf8");
  // oracle: the same accrual on the pre-refund books, done here, not by refund.mjs
  const o1 = booksFromJson(JSON.parse(withLast(T0))); accrue(o1.share, T1);
  const d1 = delta(b1.share.pending, b0.share.pending);
  check("K1 batch 1 credits the accrual since lastMs once, with the pre-refund stakes", r1.s1.code === 0 && has(r1.s1.lines, "BOOKS_OK") && b1.share.lastMs === T1 && sameMap(b1.share.pending, o1.share.pending) && sumMap(d1) === potOf(T0, T1) && (d1.get(BIG) ?? 0n) > 0n && (d1.get(TREY_A) ?? 0n) > 0n);
  check("K1 batch 1 accrual keeps the KTA books and their checks as before", accounted(b1) === w.balance && r1.c1.code === 0 && b1.share.stake.get(TREY_A) === undefined);
  const again = await w.go(["--verify", "--batch", "1"]);
  check("K1 verify after batch 1 adds nothing (exactly once)", again.code === 0 && has(again.lines, "REFUND_VERIFY: LANDED (already finished)") && sameMap(w.books().share.pending, b1.share.pending) && w.books().share.lastMs === T1);
  const d2r = await w.go(["--no-quote", "--batch", "2"]);
  const s2 = await w.go(sendArgv("2", info(d2r.lines)));
  const c2 = await w.go(["--check", "--batch", "2"]);
  const b2 = w.books();
  const d2 = delta(b2.share.pending, b1.share.pending);
  // oracle for batch 2: the books as batch 1 left them (Trey keys and bridge gone) accrued T1 -> T2, done here
  const o2 = booksFromJson(JSON.parse(b1Text)); accrue(o2.share, T2);
  const p1 = b1.share;
  check("K1 batch 2 credits T1 to T2 once, only to the stakes left after batch 1", s2.code === 0 && c2.code === 0 && b2.share.lastMs === T2 && sumMap(d2) === potOf(T1, T2) && (d2.get(TREY_A) ?? 0n) === 0n && (d2.get(BRIDGE) ?? 0n) === 0n && (d2.get(BIG) ?? 0n) > 0n && sameMap(b2.share.pending, o2.share.pending) && [...d2.keys()].every((k) => (p1.stake.get(k) ?? 0n) > 0n));
  check("K1 totals conserved: batches 1 and 2 credit exactly the KORE of T0 to T2, KTA books still match the chain", sumMap(delta(b2.share.pending, b0.share.pending)) === potOf(T0, T1) + potOf(T1, T2) && accounted(b2) === w.balance && b2.share.stake.size === 0);
  const v2 = await w.go(["--verify", "--batch", "2"]);
  check("K1 verify after batch 2 adds nothing (exactly once)", v2.code === 0 && sameMap(w.books().share.pending, b2.share.pending) && w.books().share.lastMs === T2);
}
{
  // the runner already booked past both blocks: lastMs after the block time credits nothing and does not throw
  const late = Date.parse("2026-10-25T15:00:00.000Z");
  const w = world({ booksText: withLast(late), nowMs: NOW });
  const b0 = w.books();
  const r = await throughB2(w);
  const b2 = w.books();
  check("K1 no double credit when the block time is before lastMs", r.s1.code === 0 && r.s2.code === 0 && r.c2.code === 0 && sameMap(b2.share.pending, b0.share.pending) && b2.share.lastMs === late);
}
{
  // block time equal to lastMs credits nothing
  const at = Date.parse("2026-10-25T14:00:00.000Z");
  const w = world({ booksText: withLast(at), nowMs: NOW });
  const b0 = w.books();
  const r = await throughB1(w);
  check("K1 no credit when the block time equals lastMs", r.s1.code === 0 && sameMap(w.books().share.pending, b0.share.pending) && w.books().share.lastMs === at);
}
{
  // batch 1 landed but the process died before FINISH: verify finishes it and credits the accrual once
  const w = world({ booksText: withLast(T0), landAt: [new Date(T1).toISOString()], nowMs: NOW });
  const b0 = w.books();
  const d1 = await w.go(["--no-quote", "--batch", "1"]);
  const s1 = await w.go(sendArgv("1", info(d1.lines)), { fs: { openSync: (path, flags, mode) => { if (String(path).includes("/b1/receipt-")) throw Object.assign(new Error("died"), { code: "EIO" }); return fsOpen(path, flags, mode); } } });
  const mid = w.books();
  const v = await w.go(["--verify", "--batch", "1"]);
  const o1 = booksFromJson(JSON.parse(withLast(T0))); accrue(o1.share, T1);
  check("K1 verify-finish credits the batch 1 accrual once, to the block time", s1.code === 3 && sameMap(mid.share.pending, b0.share.pending) && v.code === 0 && sameMap(w.books().share.pending, o1.share.pending) && w.books().share.lastMs === T1 && sumMap(delta(w.books().share.pending, b0.share.pending)) === potOf(T0, T1));
}
{
  // the accrual crosses 00:00 UTC (batch 1 a day later): the whole span is credited, days split as the runner does
  const T1b = Date.parse("2026-10-26T13:30:00.000Z");
  const w = world({ booksText: withLast(T0), landAt: [new Date(T1b).toISOString()], nowMs: NOW });
  const b0 = w.books();
  const r = await throughB1(w);
  const o1 = booksFromJson(JSON.parse(withLast(T0))); accrue(o1.share, T1b);
  check("K1 accrual across 00:00 UTC matches the runner accrue", r.s1.code === 0 && sameMap(w.books().share.pending, o1.share.pending) && w.books().share.lastMs === T1b && sumMap(delta(w.books().share.pending, b0.share.pending)) === potOf(T0, Date.parse("2026-10-26T00:00:00.000Z")) + potOf(Date.parse("2026-10-26T00:00:00.000Z"), T1b));
}

// ---- r5 (Ops SF1, N1, N4): a bad or future block time never ends BOOKS_OK with the accrual skipped.
const booksText = (w) => readFileSync(w.path("books.json"), "utf8");
for (const kind of ["invalid", "missing"]) {
  // SF1: an Invalid Date or a missing staple time is a history read failure: HOLD, books untouched, no done.json; R1 finishes later
  const w = world({ booksText: withLast(T0), landAt: [kind], nowMs: NOW });
  const before = booksText(w);
  const d1 = await w.go(["--no-quote", "--batch", "1"]);
  const s1 = await w.go(sendArgv("1", info(d1.lines)));
  const held = s1.code === 3 && has(s1.lines, "REFUND_HOLD: history read failed") && !has(s1.lines, "BOOKS_OK") && booksText(w) === before && !existsSync(w.path("refund", "b1", "done.json")) && w.published.length === 1;
  const v0 = await w.go(["--verify", "--batch", "1"]);
  check(`K1 ${kind} staple time: send ends REFUND_HOLD and verify REFUND_VERIFY: UNKNOWN (exit 3), books unchanged, no done.json`, held && v0.code === 3 && has(v0.lines, "REFUND_VERIFY: UNKNOWN history read failed") && booksText(w) === before && !existsSync(w.path("refund", "b1", "done.json")));
  w.history[0].voteStaple.timestamp = () => new Date(T1);
  const v1 = await w.go(["--verify", "--batch", "1"]);
  const o1 = booksFromJson(JSON.parse(withLast(T0))); accrue(o1.share, T1);
  check(`K1 ${kind} staple time: once the time reads, R1 verify finishes and credits the accrual once`, v1.code === 0 && has(v1.lines, "REFUND_VERIFY: LANDED (finished now)") && sameMap(w.books().share.pending, o1.share.pending) && w.books().share.lastMs === T1 && w.json("refund", "b1", "done.json").books === "adjusted");
}
{
  // N1: a block time more than 10 minutes after now seals a mismatch: books untouched, no accrual
  const w = world({ booksText: withLast(T0), landAt: [new Date(NOW + 3_600_000).toISOString()], nowMs: NOW });
  const before = booksText(w);
  const d1 = await w.go(["--no-quote", "--batch", "1"]);
  const s1 = await w.go(sendArgv("1", info(d1.lines)));
  check("K1 future block time (now + 1 h) seals BOOKS_MISMATCH, books unchanged", s1.code === 3 && has(s1.lines, "BOOKS_MISMATCH") && !has(s1.lines, "BOOKS_OK") && booksText(w) === before && w.json("refund", "b1", "done.json").books === "mismatch");
}
for (const [label, at] of [["epoch (0)", "1970-01-01T00:00:00.000Z"], ["before 1970", "1969-12-31T23:00:00.000Z"]]) {
  // a staple dated at or before 1970 is older than the history cutoff, so it is never taken as the refund block
  const w = world({ booksText: withLast(T0), landAt: [at], nowMs: NOW });
  const before = booksText(w);
  const d1 = await w.go(["--no-quote", "--batch", "1"]);
  const s1 = await w.go(sendArgv("1", info(d1.lines)));
  check(`K1 staple time ${label} is before the cutoff: send ends REFUND_HOLD (hash not found), books unchanged, no done.json`, s1.code === 3 && has(s1.lines, "REFUND_HOLD: hash found no") && !has(s1.lines, "BOOKS_OK") && booksText(w) === before && !existsSync(w.path("refund", "b1", "done.json")));
}
{
  // N1 boundary: 9 minutes after now is still accepted and credited to the block time
  const at = NOW + 540_000;
  const w = world({ booksText: withLast(T0), landAt: [new Date(at).toISOString()], nowMs: NOW });
  const r = await throughB1(w);
  const o1 = booksFromJson(JSON.parse(withLast(T0))); accrue(o1.share, at);
  check("K1 block time 9 minutes after now is accepted and credited once", r.s1.code === 0 && has(r.s1.lines, "BOOKS_OK") && sameMap(w.books().share.pending, o1.share.pending) && w.books().share.lastMs === at);
}
{
  // N4: the runner replays the refund staple after a restart following batch 1: nothing is credited twice,
  // and later time is credited once from the block on (the 13 stakes left still earn)
  const w = world({ booksText: withLast(T0), landAt: [new Date(T1).toISOString()], nowMs: NOW });
  const b0 = w.books();
  await throughB1(w);
  const b1 = w.books();
  const replay = w.books();
  const r1 = ingest(replay, { blocksHash: "REPLAY-1", timeMs: T1, deposits: [], ownPicks: 0 });
  const rc1 = reconcile(replay, w.balance, T1, NOW);
  const same = sameMap(replay.share.pending, b1.share.pending) && replay.share.lastMs === T1;
  const T3 = Date.parse("2026-10-25T20:00:00.000Z");
  const rc3 = reconcile(replay, w.balance, T3, NOW);
  const o3 = booksFromJson(JSON.parse(booksText(w))); accrue(o3.share, T3);
  check("K1 runner replay after batch 1 credits nothing twice; T1 to T3 is credited once", r1 === "ok" && rc1 === "ok" && rc3 === "ok" && same && sameMap(replay.share.pending, o3.share.pending) && sumMap(delta(replay.share.pending, b0.share.pending)) === potOf(T0, T1) + potOf(T1, T3));
}
{
  // N4: replay of both refund staples after batch 2: nothing is credited twice (no stake is left, so nothing more accrues)
  const w = world({ booksText: withLast(T0), landAt: [new Date(T1).toISOString(), new Date(T2).toISOString()], nowMs: NOW });
  const b0 = w.books();
  await throughB2(w);
  const b2 = w.books();
  const replay = w.books();
  const rs = [T1, T2].map((ms, i) => ingest(replay, { blocksHash: `REPLAY-${i}`, timeMs: ms, deposits: [], ownPicks: 0 }));
  const rc = reconcile(replay, w.balance, T2, NOW);
  check("K1 runner replay after batch 2 credits nothing twice; totals stay T0 to T2", rs.every((x) => x === "ok") && rc === "ok" && sameMap(replay.share.pending, b2.share.pending) && replay.share.lastMs === T2 && sumMap(delta(replay.share.pending, b0.share.pending)) === potOf(T0, T1) + potOf(T1, T2));
}

console.log(`refund batch checks ${passed}`);
