// Refund one batch of Koreminer KTA from the shaft.
// Dry run is the default. This file never calls client.send or client.recover.
// Batches (canary route, Trey via Bob Oct 21): --batch 1 pays only the canary
// wallet, --batch 2 pays every planned wallet that has no refund record, and
// --batch all is the reviewed single block. A wallet record is written with an
// exclusive create before any publish, so a wallet is never paid twice.
// Test hooks (drainSha, plannerFault, drainPath, procRoot, procRootDir, uid) are read only from
// the deps object passed to main(). No environment variable and no command-line
// flag can set them. A custom drainPath is still checked against DRAIN_SHA256
// unless drainSha is also passed on that same deps object.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accounted, booksFromJson, booksToJson } from "./books.mjs";
import { RESERVE, accrue } from "./share.mjs";
import { selectFee } from "./run.mjs";

const INTAKE = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const SINK = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const TREY_A = "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i";
const TREY_B = "keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy";
const BRIDGE = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const EXCLUDED = new Set([TREY_A, TREY_B, BRIDGE, INTAKE, SINK]);
const PINNED = [
  "keeta_aabd7qpxd6li6qwkyr4qjlzao7fu6wadr6pwhekxmem2iqtsb27wn5yphdqyv5y",
  "keeta_aab3cujp6bgzzzbacn3eyslyzt432cnqs3zbc4mbqqwcpgywfeaomtasbbyvdmi",
  "keeta_aabemrl47xovglalhxxxlfekjd2lz2aioxldryd3zkdafxk3mc4x4ojudtc76fq",
  "keeta_aabbhuaqbv5tjc25hrih6aqqel4g5fh2c6lhpmjkcxrk2xind2zft2nvhom2fwi",
  "keeta_aabalimmuxvjq5jvkvpgcnmsmyi4pwpduscrwn263pwlcib4xzpp5pnrdwng4yq",
  "keeta_aabiilnj6yja3g4j7dbn2kkxwcaxq3tdzjvm6kwgare52fsy2dzabekxgeqerki",
  "keeta_aabjveq4wsqzhj27avkdikxn3lwo5zhcv2xt6kqgwk4b55yzfaacrlmww45lu4y",
  "keeta_aabrmmctfikuanrdtlimnedov5bcshc2hmyrjlvqy5h2cvfwntlrkp6cquzakja",
  "keeta_aabffpbw6wyeyijyqz4qzmm2aatofkpkkffbetglqniohdxc4opr7i6panndway",
  "keeta_aabal6jl7dgl3xa6dkzehkbzmzuch3h5yjbmkijyo6vra6xjgzrpfv7gftdkgoy",
];
const PINNED_SET = new Set(PINNED);
const DRAIN_TOTAL = 4715n;
const DRAIN_SHA256 = "acdf2f38a9354087ac658051ac89a9c9aa6298470a6d309ec9587ebbd07a4ef9";
const REFUND_FEE_CAP = 5n * 10n ** 16n;
const RAW = 10n ** 18n;
const MEMO = "koreminer-refund-2026-10";
const CUTOFF = Date.parse("2026-10-19T21:55:00.000Z");
const MAX_PAGES = 300;
const ROOT = "/opt/koreminer";
const CANARY = "keeta_aabrmmctfikuanrdtlimnedov5bcshc2hmyrjlvqy5h2cvfwntlrkp6cquzakja";
const RECORD_NAME = /^keeta_[a-z0-9]+\.json$/;
if (!PINNED_SET.has(CANARY)) throw new Error("canary is not a pinned drain wallet");

function accountKey(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  const key = value.publicKeyString;
  if (typeof key === "string" && key) return key;
  if (key && typeof key.get === "function") {
    try {
      const text = key.get();
      if (typeof text === "string" && text) return text;
    } catch { /* try the string form */ }
  }
  if (key && typeof key.toString === "function") {
    const text = key.toString();
    if (typeof text === "string" && text && text !== "[object Object]") return text;
  }
  if (typeof value.toString === "function" && value.toString !== Object.prototype.toString) {
    const text = value.toString();
    if (typeof text === "string" && text && text !== "[object Object]") return text;
  }
  return "";
}

function hashText(value) {
  if (typeof value === "string" && value) return value;
  if (value && typeof value.toString === "function") {
    const text = value.toString();
    if (typeof text === "string" && text && text !== "[object Object]") return text;
  }
  return "";
}

function externalText(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function show(raw, places) {
  const neg = raw < 0n;
  const value = neg ? -raw : raw;
  const whole = value / RAW;
  const frac = (value % RAW).toString().padStart(18, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

function show6(raw) { return show(raw, 6); }
function show18(raw) { return show(raw, 18); }

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseDecimal(text, { maxDp = 18, allowZero = false } = {}) {
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > maxDp) return null;
  const raw = BigInt(whole) * RAW + BigInt(frac.padEnd(18, "0"));
  if (!allowZero && raw <= 0n) return null;
  if (allowZero && raw < 0n) return null;
  return raw;
}

function stamp(now) {
  return new Date(now).toISOString();
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
}

function modeOf(argv) {
  if (argv.includes("--verify")) return "verify";
  if (argv.includes("--check")) return "check";
  if (argv.includes("--no-quote")) return "no-quote";
  if (argv.includes("--send")) return "send";
  return "dry-run";
}

function bindIo(hook = {}) {
  return {
    readFileSync: hook.readFileSync ?? readFileSync,
    writeFileSync: hook.writeFileSync ?? writeFileSync,
    openSync: hook.openSync ?? openSync,
    closeSync: hook.closeSync ?? closeSync,
    fsyncSync: hook.fsyncSync ?? fsyncSync,
    fchownSync: hook.fchownSync ?? fchownSync,
    fchmodSync: hook.fchmodSync ?? fchmodSync,
    statSync: hook.statSync ?? statSync,
    mkdirSync: hook.mkdirSync ?? mkdirSync,
    chmodSync: hook.chmodSync ?? chmodSync,
    renameSync: hook.renameSync ?? renameSync,
    copyFileSync: hook.copyFileSync ?? copyFileSync,
    existsSync: hook.existsSync ?? existsSync,
    readdirSync: hook.readdirSync ?? readdirSync,
    unlinkSync: hook.unlinkSync ?? unlinkSync,
    appendFileSync: hook.appendFileSync ?? appendFileSync,
  };
}

function fsyncDir(io, dir) {
  const fd = io.openSync(dir, "r");
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}

function fileOwner(io, path) {
  try {
    const st = io.statSync(path);
    return { uid: st.uid, gid: st.gid };
  } catch {
    return { uid: process.getuid(), gid: process.getgid() };
  }
}

function atomicWrite(io, path, body, mode = 0o600) {
  const tmp = `${path}.tmp`;
  const owner = fileOwner(io, path);
  const fd = io.openSync(tmp, "w", mode);
  try {
    io.writeFileSync(fd, body);
    io.fchownSync(fd, owner.uid, owner.gid); // GUARD:H7-owner
    io.fchmodSync(fd, mode); // GUARD:H7-mode
    io.fsyncSync(fd); // GUARD:H7-fsync
  } finally { io.closeSync(fd); }
  io.renameSync(tmp, path);
  fsyncDir(io, dirname(path));
}

function ensureRefundDir(io, dir) {
  const path = `${dir}/refund`;
  io.mkdirSync(path, { recursive: true, mode: 0o700 });
  io.chmodSync(path, 0o700); // GUARD:file-modes
  return path;
}

function batchOf(argv) {
  const value = flag(argv, "--batch");
  return value === "1" || value === "2" || value === "all" ? value : "";
}

function batchDirOf(dir, batch) {
  return batch === "all" ? `${dir}/refund` : `${dir}/refund/b${batch}`;
}

function ensureBatchDir(io, dir, batch) {
  const refundDir = ensureRefundDir(io, dir);
  if (batch === "all" || batch === undefined) return refundDir;
  const path = `${refundDir}/b${batch}`;
  io.mkdirSync(path, { recursive: true, mode: 0o700 });
  io.chmodSync(path, 0o700);
  return path;
}

function exclusiveWrite(io, path, body) {
  const fd = io.openSync(path, "wx", 0o600);
  try {
    io.writeFileSync(fd, body);
    io.fchmodSync(fd, 0o600);
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
}

function readJson(io, path) {
  try {
    const body = JSON.parse(io.readFileSync(path, "utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function amountOf(value) {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  } catch { /* fall through */ }
  return -1n;
}

function readRecords(io, dir) {
  const path = `${dir}/refund/wallets`;
  if (!io.existsSync(path)) return { ok: true, keys: [], records: new Map() };
  let names;
  try { names = io.readdirSync(path).map(String); }
  catch { return { ok: false, why: "wallet records are unreadable" }; }
  const records = new Map();
  for (const name of names) {
    if (!RECORD_NAME.test(name)) return { ok: false, why: `unexpected file in refund/wallets: ${name.slice(0, 80)}` };
    const key = name.slice(0, -5);
    const body = readJson(io, `${path}/${name}`);
    if (!body || body.key !== key) return { ok: false, why: `wallet record is unreadable: ${key}` };
    records.set(key, body);
  }
  return { ok: true, keys: [...records.keys()].sort(), records };
}

function planFromFile(body) {
  if (!body || !Array.isArray(body.rows) || typeof body.fullPlan !== "string") return null;
  const rows = [];
  try {
    for (const row of body.rows) {
      if (!row || typeof row.key !== "string") return null;
      const item = { key: row.key, stake: amountOf(row.stake), weight: String(row.weight), addback: amountOf(row.addback), amount: amountOf(row.amount) };
      if (item.stake < 0n || item.addback < 0n || item.amount <= 0n || item.stake + item.addback !== item.amount) return null;
      rows.push(item);
    }
  } catch { return null; }
  if (rows.length === 0 || new Set(rows.map((row) => row.key)).size !== rows.length) return null;
  if (digestOf(rows) !== body.fullPlan) return null;
  const pool = amountOf(body.pool);
  const addbacks = amountOf(body.addbacks);
  if (pool < 0n || addbacks < 0n) return null;
  let total = 0n;
  for (const row of rows) total += row.amount;
  return { rows, fullPlan: body.fullPlan, pool, addbacks, dust: pool - addbacks, total };
}

function tokenIsKta(token, base, baseText) {
  if (token === undefined || token === null || token === "") return true;
  if (typeof token?.comparePublicKey === "function") return token.comparePublicKey(base) === true;
  if (base !== undefined && token === base) return true;
  const text = accountKey(token);
  if (!text) return false;
  if (baseText && text === baseText) return true;
  if (base?.id && text === base.id) return true;
  const baseKey = accountKey(base);
  if (baseKey && text === baseKey) return true;
  return false;
}

function sumKtaSends(block, base, baseText) {
  let total = 0n;
  let foreign = false;
  const ops = Array.isArray(block?.operations) ? block.operations : [];
  for (const op of ops) {
    if (op?.type !== 0 && op?.type !== "SEND") continue;
    let amount = 0n;
    try {
      if (typeof op.amount === "bigint") amount = op.amount;
      else if (op.amount !== undefined && op.amount !== null && op.amount !== "") amount = BigInt(op.amount);
    } catch {
      amount = 0n;
    }
    if (!tokenIsKta(op?.token, base, baseText)) {
      foreign = true;
      continue;
    }
    total += amount;
  }
  return { total, foreign };
}

function judgeVotes(entries, base, baseText) {
  const list = Array.isArray(entries) ? entries : entries == null ? [] : [entries];
  if (list.length === 0) return { usable: false, foreign: false, kta: 0n };
  let kta = 0n;
  let foreign = false;
  let usable = false;
  for (const entry of list) {
    const fee = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "fee") ? entry.fee : entry;
    const picked = selectFee(fee, { base, baseText });
    if (picked.kind === "none") continue;
    usable = true;
    if (picked.kind === "free") continue;
    if (picked.kind === "foreign") {
      foreign = true;
      continue;
    }
    kta += picked.amount;
  }
  return { usable, foreign, kta };
}

function makeFee(client, base, baseText) {
  const taken = { fee: 0n, used: false };
  async function generateFeeBlock(staple) {
    const votes = staple?.votes ?? [];
    if (votes.length === 0) {
      const err = new Error("No usable fee.");
      err.name = "FeeUnusable";
      throw err;
    }
    let ktaFee = 0n;
    let foreign = false;
    let usable = false;
    for (const vote of votes) {
      const picked = selectFee(vote?.fee, { base, baseText });
      if (picked.kind === "none") continue;
      usable = true;
      if (picked.kind === "free") continue;
      if (picked.kind === "foreign") {
        foreign = true;
        continue;
      }
      ktaFee += picked.amount;
    }
    if (!usable) {
      const err = new Error("No usable fee.");
      err.name = "FeeUnusable";
      throw err;
    }
    if (foreign) { // GUARD:G10-vote-foreign
      const err = new Error("Non-KTA fee.");
      err.name = "FeeForeign";
      throw err;
    }
    if (ktaFee > REFUND_FEE_CAP) { // GUARD:G10-vote
      const err = new Error("Fee over cap.");
      err.name = "FeeOverCap";
      throw err;
    }
    const builder = client.initBuilder();
    const block = await builder.computeFeeBlock(staple);
    const built = sumKtaSends(block, base, baseText);
    if (built.foreign || built.total !== ktaFee || built.total > REFUND_FEE_CAP) { // GUARD:G10-built
      const err = new Error("Built fee does not match.");
      err.name = "FeeBuilt";
      throw err;
    }
    taken.fee = ktaFee;
    taken.used = true;
    return block;
  }
  return { generateFeeBlock, taken };
}

function feeReason(err) {
  if (err?.name === "FeeBuilt") return "built fee block does not match";
  if (err?.name === "FeeForeign") return "vote fee is non-KTA";
  if (err?.name === "FeeOverCap") return "vote fee is over the refund fee cap";
  return "quote is unusable";
}

function stapleTime(staple) {
  try {
    const value = typeof staple?.timestamp === "function" ? staple.timestamp() : staple?.timestamp;
    if (value instanceof Date) return value.getTime();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const ms = Date.parse(String(value));
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

async function readHistory(client) {
  const memos = [];
  const staples = [];
  let start;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let rows;
    try {
      const query = { depth: 100, startBlocksHash: start };
      rows = typeof client.getHistory === "function"
        ? await client.getHistory(INTAKE, query)
        : await client.history(query);
    } catch {
      return { error: true, capped: false, memos, staples };
    }
    if (!Array.isArray(rows)) return { error: true, capped: false, memos, staples };
    if (rows.length === 0) return { error: false, capped: false, memos, staples };
    let stop = false;
    for (const row of rows) {
      const staple = row?.voteStaple ?? row;
      const when = stapleTime(staple);
      if (when === null) return { error: true, capped: false, memos, staples };
      if (when < CUTOFF) {
        stop = true;
        break;
      }
      const blocks = Array.isArray(staple?.blocks) ? staple.blocks : [];
      staples.push({ stapleHash: hashText(staple?.blocksHash), blocks, timeMs: when });
      for (const block of blocks) {
        if (accountKey(block?.account) !== INTAKE) continue;
        const hash = hashText(block?.hash);
        for (const op of block?.operations ?? []) {
          if (op?.type !== 0 && op?.type !== "SEND") continue;
          if (externalText(op?.external) === MEMO) memos.push({ hash: hash || "unknown", to: accountKey(op?.to), amount: amountOf(op?.amount) }); // GUARD:S2
        }
      }
    }
    if (stop || rows.length < 100) return { error: false, capped: false, memos, staples };
    const last = rows[rows.length - 1]?.voteStaple ?? rows[rows.length - 1];
    const next = hashText(last?.blocksHash);
    if (!next || next === start) return { error: true, capped: false, memos, staples };
    start = next;
  }
  return { error: false, capped: true, memos, staples };
}

function feeFor(staple, refundHash, base, baseText) {
  let fee = 0n;
  let foreign = false;
  for (const block of staple.blocks ?? []) {
    if (accountKey(block?.account) !== INTAKE) continue;
    if (hashText(block?.hash) === refundHash) continue;
    const part = sumKtaSends(block, base, baseText);
    fee += part.total;
    if (part.foreign) foreign = true;
  }
  return { fee, foreign };
}

function findHash(hist, hash, base, baseText) {
  for (const staple of hist?.staples ?? []) {
    for (const block of staple.blocks ?? []) {
      if (accountKey(block?.account) !== INTAKE) continue;
      if (hashText(block?.hash) !== hash) continue;
      const fee = feeFor(staple, hash, base, baseText);
      return { found: true, fee: fee.fee, foreign: fee.foreign, stapleHash: staple.stapleHash, timeMs: staple.timeMs };
    }
  }
  return { found: false, fee: 0n, foreign: false, stapleHash: "" };
}

function batchProblem(block, rows, total, base, baseText) {
  if (!block || !Array.isArray(rows) || rows.length === 0 || rows.length > 50) return "shape";
  const ops = Array.isArray(block.operations) ? block.operations : [];
  if (ops.length !== rows.length) return "shape";
  const seen = new Map();
  let sum = 0n;
  for (const op of ops) {
    if (op?.type !== 0 && op?.type !== "SEND") return "shape";
    if (externalText(op.external) !== MEMO) return "shape";
    if (tokenIsKta(op.token, base, baseText) !== true || op.token == null || op.token === "") return "shape";
    if (typeof op.amount !== "bigint") return "shape";
    const who = accountKey(op.to);
    if (!who || seen.has(who)) return "shape";
    seen.set(who, op.amount);
    sum += op.amount;
  }
  if (sum !== total) return "shape";
  for (const row of rows) {
    if (seen.get(row.key) !== row.amount) return "shape";
  }
  return "";
}

function hasBookRow(books, key) {
  if (books.share.stake.has(key)) return true;
  if (books.share.depth.has(key)) return true;
  return books.share.lots.some((lot) => lot.from === key);
}

function planOf(books, weights) {
  const pool = (books.share.stake.get(TREY_A) ?? 0n)
    + (books.share.stake.get(TREY_B) ?? 0n)
    + (books.share.stake.get(BRIDGE) ?? 0n)
    - REFUND_FEE_CAP;
  const denom = DRAIN_TOTAL * RAW;
  const weightOf = new Map(weights.map((row) => [row.key, row.weight]));
  const keys = new Set();
  for (const key of books.share.stake.keys()) {
    if (String(key).startsWith("keeta_")) keys.add(key);
  }
  for (const row of weights) keys.add(row.key);
  const rows = [];
  let addbacks = 0n;
  for (const key of keys) {
    if (EXCLUDED.has(key)) continue; // GUARD:exclusion
    const stake = books.share.stake.get(key) ?? 0n;
    const weight = weightOf.has(key) ? weightOf.get(key) : "0";
    const weightRaw = weightOf.has(key) ? parseDecimal(weight, { allowZero: true }) ?? 0n : 0n;
    const addback = pool > 0n && weightRaw > 0n ? (pool * weightRaw) / denom : 0n;
    addbacks += addback;
    const amount = stake + addback;
    if (amount === 0n) continue;
    rows.push({ key, stake, weight, addback, amount });
  }
  rows.sort((a, b) => (a.amount === b.amount ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.amount > b.amount ? -1 : 1));
  let total = 0n;
  for (const row of rows) total += row.amount;
  return { pool, addbacks, dust: pool > 0n ? pool - addbacks : 0n, total, rows };
}

function digestOf(rows) {
  const lines = rows.map((row) => `${row.key}:${row.amount.toString()}`);
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(Buffer.from(lines.join("\n"), "utf8"));
}

function assertPlan(rows, total) {
  for (const row of rows) {
    if (EXCLUDED.has(row.key)) return "excluded";
    if (!(row.amount > 0n)) return "amount";
  }
  let sum = 0n;
  let nonzero = 0;
  for (const row of rows) {
    if (row.amount > 0n) nonzero += 1;
    sum += row.amount;
  }
  if (nonzero !== rows.length) return "count";
  if (sum !== total) return "sum";
  return "";
}

function excludedRows(books) {
  return [TREY_A, TREY_B, BRIDGE, INTAKE, SINK].map((key) => ({
    key,
    stake: books.share.stake.get(key) ?? 0n,
  }));
}

function summaryLines(planned, books, feeText, balance, after) {
  const lines = planned.rows.map((row, index) => (
    `${index + 1} ${row.key} stake ${show6(row.stake)} weight ${row.weight} addback ${show6(row.addback)} total ${show6(row.amount)} raw ${row.amount.toString()}`
  ));
  for (const row of excludedRows(books)) {
    lines.push(`EXCLUDED ${row.key} stake ${show6(row.stake)} raw ${row.stake.toString()}`);
  }
  lines.push(`POOL ${show18(planned.pool)}`);
  lines.push(`ADDBACKS ${show18(planned.addbacks)}`);
  lines.push(`DUST ${planned.dust.toString()}`);
  lines.push(`TOTAL ${show18(planned.total)}`);
  lines.push(`N ${planned.rows.length}`);
  lines.push(`PLAN ${planned.digest}`);
  lines.push(`FEE ${feeText}`);
  lines.push(`BALANCE ${show18(balance)}`);
  lines.push(`AFTER ${show18(after)}`);
  return lines;
}

function booksReason(booksTotal, chain) {
  const diff = chain - booksTotal;
  return `books ${show18(booksTotal)} chain ${show18(chain)} difference ${diff.toString()}. Do not edit books. Unbooked deposits need a reviewed booking step first.`;
}

function loadBooks(io, dir) {
  const raw = JSON.parse(io.readFileSync(`${dir}/books.json`, "utf8"));
  return booksFromJson(raw);
}

function readDrain(io, deps) {
  const path = deps.drainPath ?? fileURLToPath(new URL("./refund-drain.json", import.meta.url));
  const bytes = io.readFileSync(path);
  const expected = Object.prototype.hasOwnProperty.call(deps, "drainSha") ? deps.drainSha : DRAIN_SHA256;
  return { bytes, parsed: JSON.parse(Buffer.from(bytes).toString("utf8")), expected, sha: sha256(bytes) };
}

function processIsRunner(proc, hook = {}) {
  const root = typeof hook.procRootDir === "string" ? hook.procRootDir : ROOT;
  const argv = Array.isArray(proc?.argv) ? proc.argv.map(String) : [];
  const cwd = typeof proc?.cwd === "string" ? proc.cwd : "";
  const runners = [];
  for (const arg of argv) {
    if (arg.split("/").pop() !== "run.mjs") continue;
    runners.push(arg);
  }
  if (runners.length === 0) return false;
  // Literal checks from 459b7e0. A match is the runner, and no realpath is needed.
  for (const arg of runners) { // GUARD:H3-literal
    if (cwd === root) return true;
    const abs = arg.startsWith("/") ? arg : resolve(cwd || "/", arg);
    if (abs === root || abs.startsWith(`${root}/`)) return true;
  }
  let rootReal;
  try { rootReal = realpathSync(root); }
  catch { return false; } // GUARD:H3-root-realpath
  const rootPrefix = `${rootReal}/`;
  let cwdReal;
  try { cwdReal = realpathSync(cwd || "/"); }
  catch {
    const err = new Error("process list unreadable");
    err.name = "ProcessListUnreadable";
    throw err; // GUARD:H3-cwd-realpath
  }
  if (cwdReal === rootReal) return true; // GUARD:H3-realpath-cwd
  for (const arg of runners) {
    const abs = arg.startsWith("/") ? arg : resolve(cwd || "/", arg);
    let real;
    try { real = realpathSync(abs); }
    catch {
      const err = new Error("process list unreadable");
      err.name = "ProcessListUnreadable";
      throw err; // GUARD:H3-argv-realpath
    }
    if (real === rootReal || real.startsWith(rootPrefix)) return true; // GUARD:H3-realpath
  }
  return false;
}

function defaultSystemctl() {
  try {
    const out = spawnSync("systemctl", ["is-active", "koreminer"], { encoding: "utf8" });
    const text = `${out.stdout ?? ""}`.trim();
    return text || "unknown";
  } catch {
    return "unknown";
  }
}

function defaultProcesses(root = "/proc") {
  let names;
  try { names = readdirSync(root); }
  catch {
    const err = new Error("process list unreadable");
    err.name = "ProcessListUnreadable";
    throw err;
  }
  const found = [];
  for (const pid of names) {
    if (!/^\d+$/.test(pid)) continue;
    let argvText;
    try { argvText = readFileSync(`${root}/${pid}/cmdline`); }
    catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ESRCH") continue; // GUARD:F1-vanished
      const refused = new Error("process list unreadable");
      refused.name = "ProcessListUnreadable";
      throw refused; // GUARD:F1-eacces
    }
    const argv = Buffer.from(argvText).toString("utf8").split("\0").filter(Boolean);
    if (argv.length === 0) continue; // GUARD:F1-zombie
    // Empty command lines were skipped above, so they do not reach the cwd read.
    if (argv.length > 0 && !argv.some((arg) => arg.split("/").pop() === "run.mjs")) { // GUARD:F1-other-cwd
      found.push({ pid, argv });
      continue;
    }
    let cwd;
    try { cwd = readlinkSync(`${root}/${pid}/cwd`); }
    catch {
      const err = new Error("process list unreadable");
      err.name = "ProcessListUnreadable";
      throw err; // GUARD:F1-run-cwd
    }
    found.push({ pid, argv, cwd });
  }
  return found;
}

async function valueOf(fn) {
  return typeof fn === "function" ? fn() : fn;
}

async function chainBalance(client, base) {
  let value;
  try { value = await client.balance(base); }
  catch { throw new Error("balance"); }
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new Error("balance");
}

function publishedHashes(result) {
  const blocks = result?.from === "publish-aid" ? result?.blocks : result?.voteStaple?.blocks;
  return (blocks ?? []).map((block) => hashText(block?.hash)).filter(Boolean);
}

function classifyLanding({ hashFound, feeOk, pending, balance, before, total, fee }) {
  if (hashFound && feeOk && !pending && balance === before - total - fee) return "LANDED";
  if (hashFound) return "HOLD";
  if (pending) return "PENDING";
  if (balance === before) return "NOT_LANDED";
  return "HOLD";
}

function applyBooks(books, recipients, addbacks, fee) {
  const drop = new Set(recipients.map((row) => row.key));
  for (const key of EXCLUDED) drop.add(key);
  let excludedStake = 0n;
  for (const key of EXCLUDED) excludedStake += books.share.stake.get(key) ?? 0n;
  for (const key of drop) books.share.stake.delete(key);
  books.share.lots = books.share.lots.filter((lot) => !drop.has(lot.from));
  books.operator += excludedStake - addbacks - fee;
  return excludedStake;
}

function booksAssertions(books, chainBalanceNow, recipients, reserveBefore) {
  if (accounted(books) !== chainBalanceNow) return "accounted";
  const lots = new Map();
  for (const lot of books.share.lots) lots.set(lot.from, (lots.get(lot.from) ?? 0n) + BigInt(lot.remaining));
  const keys = new Set([...books.share.stake.keys(), ...lots.keys()]);
  for (const key of keys) {
    if ((books.share.stake.get(key) ?? 0n) !== (lots.get(key) ?? 0n)) return "lots";
  }
  const drop = new Set(recipients.map((row) => row.key));
  for (const key of EXCLUDED) drop.add(key);
  for (const key of drop) {
    if ((books.share.stake.get(key) ?? 0n) !== 0n) return "stake";
    if (books.share.lots.some((lot) => lot.from === key)) return "lots";
  }
  if (books.operator < 0n) return "operator"; // GUARD:H4-operator
  if (books.share.reserve !== reserveBefore) return "reserve"; // GUARD:H4-reserve
  return "";
}

function sealDone(ctx, refundDir, booksField) {
  const done = {
    block: ctx.intent.block,
    total: ctx.intent.total,
    plan: ctx.intent.plan,
    books: booksField, // GUARD:H2-books
  };
  atomicWrite(ctx.io, `${refundDir}/done.json`, `${JSON.stringify(done, null, 2)}\n`);
}

function confirmBooks(io, path, prior) {
  const after = io.statSync(path);
  const mask = 0o7777; // GUARD:H7-mode-mask
  return after.uid === prior.uid && after.gid === prior.gid && (after.mode & mask) === (prior.mode & mask);
}

function bestEffortUnlink(io, path) {
  try { io.unlinkSync(path); } catch { /* a failed remove does not change the outcome */ }
}

function writeBooksFile(io, path, body, mode) {
  const tmp = `${path}.tmp`;
  const owner = fileOwner(io, path);
  let renamed = false;
  try {
    const fd = io.openSync(tmp, "w", mode);
    try {
      io.writeFileSync(fd, body);
      io.fchownSync(fd, owner.uid, owner.gid); // GUARD:H7-owner
      io.fchmodSync(fd, mode); // GUARD:H7-mode
      io.fsyncSync(fd); // GUARD:H7-fsync
    } finally { io.closeSync(fd); }
    io.renameSync(tmp, path);
    renamed = true;
    fsyncDir(io, dirname(path));
  } catch (err) {
    if (!renamed) bestEffortUnlink(io, tmp); // GUARD:N4-tmp
    if (err && typeof err === "object") err.booksRenamed = renamed;
    throw err;
  }
}

function sealMismatch(ctx, refundDir) {
  sealDone(ctx, refundDir, "mismatch"); // GUARD:N4-before
  ctx.say("BOOKS_MISMATCH");
  return 3;
}

function sealUnconfirmed(ctx, refundDir) {
  sealDone(ctx, refundDir, "unconfirmed"); // GUARD:N4-after
  ctx.say("BOOKS_UNCONFIRMED");
  return 3;
}

function finishBooks(ctx, verdict) {
  ctx.say(`REFUND_LANDED ${ctx.intent.block}`); // GUARD:H2-landed
  const when = stamp(ctx.now());
  const refundDir = ensureBatchDir(ctx.io, ctx.dir, ctx.batch);
  const booksPath = `${ctx.dir}/books.json`;
  const books = loadBooks(ctx.io, ctx.dir);
  const reserveBefore = Object.prototype.hasOwnProperty.call(ctx, "reserveBefore") ? ctx.reserveBefore : books.share.reserve;
  // KeeLend Ops fix (i): credit the KORE earned since the books' last chain block up to this refund block,
  // with the stakes as they were before the refund, then take the refunded KTA out. Never moves time back,
  // so a block at or before lastMs credits nothing (no double credit after the runner already booked past it).
  const blockMs = Number.isFinite(verdict.blockMs) ? verdict.blockMs : books.share.lastMs;
  accrue(books.share, Math.max(books.share.lastMs, blockMs)); // GUARD:K1-accrue
  applyBooks(books, ctx.intent.recipients, BigInt(ctx.intent.addbacks), verdict.fee); // GUARD:books-adjust
  const problem = booksAssertions(books, verdict.balance, ctx.intent.recipients, reserveBefore); // GUARD:R5
  const receipt = {
    block: ctx.intent.block,
    staple: verdict.stapleHash ?? "",
    wallets: ctx.intent.recipients.map((row) => ({
      key: row.key,
      raw: row.amount,
      show: show6(BigInt(row.amount)),
    })),
    fee: verdict.fee.toString(),
    balanceBefore: ctx.intent.balanceBefore,
    balanceAfter: verdict.balance.toString(),
    plan: ctx.intent.plan,
  };
  atomicWrite(ctx.io, `${refundDir}/receipt-${when}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  if (problem) return sealMismatch(ctx, refundDir);
  let prior;
  try { prior = ctx.io.statSync(booksPath); }
  catch { return sealMismatch(ctx, refundDir); } // GUARD:N4-stat
  const backup = `${ctx.dir}/books.json.pre-refund-${when}`;
  try {
    ctx.io.copyFileSync(booksPath, backup);
    ctx.io.chmodSync(backup, 0o600);
    const fd = ctx.io.openSync(backup, "r+");
    try { ctx.io.fsyncSync(fd); } finally { ctx.io.closeSync(fd); }
  } catch { return sealMismatch(ctx, refundDir); } // GUARD:N4-backup
  const booksMode = prior.mode & 0o7777; // GUARD:H7-mode-mask
  try {
    writeBooksFile(ctx.io, booksPath, `${JSON.stringify(booksToJson(books), null, 2)}\n`, booksMode); // GUARD:H7-books
  } catch (err) {
    if (err?.booksRenamed) return sealUnconfirmed(ctx, refundDir);
    return sealMismatch(ctx, refundDir);
  }
  try {
    if (!confirmBooks(ctx.io, booksPath, prior)) return sealUnconfirmed(ctx, refundDir); // GUARD:H7-confirm
  } catch { return sealUnconfirmed(ctx, refundDir); } // GUARD:N4-confirm
  sealDone(ctx, refundDir, "adjusted"); // GUARD:H7-done
  ctx.say("BOOKS_OK");
  return 0;
}

function unpayableStake(books) {
  for (const [key, amount] of books.share.stake) {
    if (amount > 0n && (!String(key).startsWith("keeta_") || key === INTAKE || key === SINK)) return true;
  }
  return false;
}

function drainProblem(drain, books) {
  if (drain.sha !== drain.expected) return "drain file hash does not match"; // seen with GUARD below
  const weights = drain.parsed?.weights;
  if (!Array.isArray(weights) || weights.length !== 10) return "drain weights are not the pinned set";
  if (weights.some((row) => row && EXCLUDED.has(row.key))) return "drain key is excluded";
  const seen = new Set();
  for (const row of weights) {
    if (!row || typeof row.key !== "string" || typeof row.weight !== "string" || seen.has(row.key)) {
      return "drain weights are not the pinned set";
    }
    seen.add(row.key);
  }
  if (seen.size !== PINNED_SET.size || [...seen].some((key) => !PINNED_SET.has(key))) {
    return "drain weights are not the pinned set";
  }
  if (weights.some((row) => parseDecimal(row.weight) === null)) return "drain weight is invalid";
  let weightSum = 0n;
  for (const row of weights) weightSum += parseDecimal(row.weight, { allowZero: true }) ?? 0n;
  const totalField = parseDecimal(String(drain.parsed?.total ?? ""), { allowZero: true });
  if (totalField === null || weightSum !== totalField || totalField !== DRAIN_TOTAL * RAW) {
    return "drain total does not match";
  }
  if (weights.some((row) => !hasBookRow(books, row.key))) return "drain key is not in the books";
  return "";
}

function sliceOf(full, rows) {
  let total = 0n;
  let addbacks = 0n;
  for (const row of rows) {
    total += row.amount;
    addbacks += row.addback;
  }
  return { pool: full.pool, addbacks, dust: full.dust, total, rows, digest: digestOf(rows) };
}

function batchLines(batch, full, preview) {
  if (batch === "all") return [];
  const lines = [`FULLPLAN ${full.digest}`, `FULL N ${full.rows.length} TOTAL ${show18(full.total)}`];
  if (preview) lines.push(`NEXT BATCH 2 N ${preview.rows.length} TOTAL ${show18(preview.total)} PLAN ${preview.digest}`);
  return lines;
}

function sameRecipients(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((row, index) => row && right[index] && row.key === right[index].key && String(row.amount) === String(right[index].amount));
}

function readIntent(io, path) {
  let bytes;
  try { bytes = io.readFileSync(path); }
  catch { return null; }
  try {
    const intent = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!intent || typeof intent !== "object" || !Array.isArray(intent.recipients)) return { bytes, intent: null };
    return { bytes, intent };
  } catch {
    return { bytes, intent: null };
  }
}

function loadBatchOne(io, R) {
  const read = readIntent(io, `${R}/b1/intent.json`);
  const plan = planFromFile(readJson(io, `${R}/plan.json`));
  return { intent: read.intent, plan, amount: amountOf(read.intent.recipients[0].amount) };
}

function batchOneProblem(io, R, recs) {
  const read = readIntent(io, `${R}/b1/intent.json`);
  if (!read) return "batch 1 has not been sent";
  const intent = read.intent;
  if (!intent || intent.batch !== "1" || intent.recipients.length !== 1 || intent.recipients[0]?.key !== CANARY || amountOf(intent.recipients[0]?.amount) <= 0n) {
    return "batch 1 intent is not the canary"; // GUARD:W-b1-intent
  }
  const done = readJson(io, `${R}/b1/done.json`);
  if (!done || done.books !== "adjusted" || done.block !== intent.block) return "batch 1 books are not adjusted"; // GUARD:W-b1-done
  const verified = readJson(io, `${R}/b1/verified.json`);
  if (!verified) return "batch 1 is not verified"; // GUARD:W-b1-verified
  const plan = planFromFile(readJson(io, `${R}/plan.json`));
  if (!plan || plan.fullPlan !== intent.fullPlan || !plan.rows.some((row) => row.key === CANARY && row.amount.toString() === intent.recipients[0].amount)) {
    return "frozen plan does not match"; // GUARD:W-plan
  }
  if (verified.batch !== "1" || verified.block !== intent.block || verified.intentSha !== sha256(read.bytes) || verified.fullPlan !== plan.fullPlan || !sameRecipients(verified.recipients, intent.recipients)) {
    return "batch 1 verify marker does not match"; // GUARD:W-b1-marker
  }
  if (recs.keys.length !== 1 || recs.keys[0] !== CANARY) return `wallet records are not batch 1 only (${recs.keys.length})`; // GUARD:W-rec-set
  const rec = recs.records.get(CANARY);
  if (rec.batch !== "1" || rec.block !== intent.block || rec.amount !== intent.recipients[0].amount) return "batch 1 wallet record does not match"; // GUARD:W-rec-block
  return "";
}

// Read-only on chain, books and runner. Never loads the seed and never builds.
// Its only write is <batch dir>/verified.json, created once (exclusive).
async function checkBatch({ deps, dir, batch, bdir, io, say, owned }) {
  function no(why) {
    say(`REFUND_BATCH_NOT_VERIFIED: ${why}`);
    return 3;
  }
  const read = readIntent(io, `${bdir}/intent.json`);
  if (!read) return no("no intent for this batch");
  const intent = read.intent;
  if (!intent) return no("intent is unreadable");
  const done = readJson(io, `${bdir}/done.json`);
  if (!done || done.books !== "adjusted" || done.block !== intent.block) return no("books are not adjusted for this batch"); // GUARD:C-done
  const expected = intent.recipients.map((row) => `${intent.block}:${row.key}:${row.amount}`);
  const touched = intent.recipients.map((row) => row.key);
  if (batch === "2") {
    const one = readIntent(io, `${dir}/refund/b1/intent.json`);
    const v1 = readJson(io, `${dir}/refund/b1/verified.json`);
    if (!one || !one.intent || !v1 || v1.block !== one.intent.block || v1.intentSha !== sha256(one.bytes)) return no("batch 1 is not verified"); // GUARD:C-b1-first
    for (const row of one.intent.recipients) {
      expected.push(`${one.intent.block}:${row.key}:${row.amount}`);
      touched.push(row.key);
    }
  }
  let names;
  try { names = io.readdirSync(bdir).map(String).filter((name) => name.startsWith("receipt-")); }
  catch { names = []; }
  if (names.length !== 1) return no(`expected exactly one receipt, found ${names.length}`); // GUARD:C-receipt
  const receipt = readJson(io, `${bdir}/${names[0]}`);
  if (!receipt || receipt.block !== intent.block) return no("receipt is unreadable or for another block");
  const { base, baseText } = await resolveChain(deps);
  const client = deps.client ?? await openReadOnly(deps, owned);
  let hist;
  try { hist = await readHistory(client); }
  catch { hist = { error: true, capped: false, memos: [], staples: [] }; }
  if (hist.error || hist.capped) return no("history read failed or hit the page cap");
  let pending;
  let balance;
  try {
    pending = await client.pendingBlock();
    balance = await chainBalance(client, base);
  } catch {
    return no("chain read failed");
  }
  if (pending) return no("a block is pending"); // GUARD:C-pending
  const hit = findHash(hist, intent.block, base, baseText);
  if (!hit.found) return no("block is not on chain");
  if (hit.foreign || hit.fee > REFUND_FEE_CAP || hit.fee !== amountOf(receipt.fee)) return no(`fee on chain ${show18(hit.fee)} is over the cap or differs from the receipt`); // GUARD:C-fee
  const onChain = hist.memos.map((m) => `${m.hash}:${m.to}:${m.amount.toString()}`).sort();
  expected.sort();
  if (onChain.length !== expected.length || onChain.some((item, index) => item !== expected[index])) {
    return no(`refund sends on chain (${onChain.length}) do not match the sent batches (${expected.length})`); // GUARD:C-ops
  }
  if (new Set(hist.memos.map((m) => m.to)).size !== hist.memos.length) return no("a wallet has more than one refund on chain"); // GUARD:C-once
  if (balance !== amountOf(receipt.balanceAfter)) return no(`balance ${show18(balance)} moved since the receipt`); // GUARD:C-balance
  let books;
  try { books = loadBooks(io, dir); }
  catch { return no("books are unreadable"); }
  if (accounted(books) !== balance) return no(booksReason(accounted(books), balance)); // GUARD:C-books-chain
  for (const key of [...touched, TREY_A, TREY_B, BRIDGE]) {
    if ((books.share.stake.get(key) ?? 0n) !== 0n || books.share.lots.some((lot) => lot.from === key)) return no(`books still hold stake for ${key}`); // GUARD:C-books-zero
  }
  const marker = {
    batch,
    block: intent.block,
    staple: hit.stapleHash,
    intentSha: sha256(read.bytes),
    fullPlan: intent.fullPlan,
    recipients: intent.recipients.map((row) => ({ key: row.key, amount: row.amount })),
    fee: hit.fee.toString(),
    balanceAfter: balance.toString(),
  };
  const body = `${JSON.stringify(marker, null, 2)}\n`;
  const path = `${bdir}/verified.json`;
  if (io.existsSync(path)) {
    if (io.readFileSync(path, "utf8") !== body) return no("verify marker exists and differs"); // GUARD:C-marker
    say("already verified, marker unchanged");
  } else {
    exclusiveWrite(io, path, body);
  }
  for (const row of intent.recipients) say(`PAID ${row.key} ${show18(BigInt(row.amount))} raw ${row.amount}`);
  say(`BLOCK ${intent.block} STAPLE ${hit.stapleHash || "unknown"}`);
  say(`FEE ${show18(hit.fee)}`);
  say(`BALANCE ${show18(balance)}`);
  say(`REFUND_SENDS_ON_CHAIN ${hist.memos.length}`);
  say(`REFUND_BATCH_VERIFIED ${batch} ${intent.block}`);
  return 0;
}

async function main(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const dir = deps.dir ?? ROOT;
  const now = deps.now ?? (() => Date.now());
  const output = deps.output ?? ((line) => console.log(line));
  const systemctl = deps.systemctl ?? defaultSystemctl;
  const processes = deps.processes ?? defaultProcesses;
  const io = bindIo(deps.fs);
  const mode = modeOf(argv);
  const when = stamp(now());
  const lines = [];
  let logPath = "";
  function say(line) {
    lines.push(line);
    output(line);
    if (logPath) {
      io.appendFileSync(logPath, `${line}\n`);
      io.chmodSync(logPath, 0o600);
    }
  }
  function refuse(reason) {
    say(`REFUND_REFUSED: ${reason}`);
    return 2;
  }
  const owned = [];
  let stopOpen = false;
  try {
  const uid = deps.uid !== undefined ? deps.uid : process.getuid();
  if (uid !== 0) return refuse("must run as root"); // GUARD:H3-root
  const batch = batchOf(argv);
  if (mode !== "verify" && mode !== "check") {
    const refundDir = ensureRefundDir(io, dir);
    logPath = `${refundDir}/refund-${when}.log`;
    io.appendFileSync(logPath, "");
    io.chmodSync(logPath, 0o600);
  }
  say(`REFUND ${mode} ${when}`);
  if (!batch) return refuse("batch flag is missing or invalid"); // GUARD:W-batch-flag
  const bdir = batchDirOf(dir, batch);
  if (batch !== "all") say(`BATCH ${batch}`);

  if (mode === "check") return await checkBatch({ deps, dir, batch, bdir, io, say, owned });

  if (mode === "verify") {
    const intentPath = `${bdir}/intent.json`;
    if (!io.existsSync(intentPath)) {
      say("REFUND_VERIFY: no intent");
      return 0;
    }
    let intent;
    try { intent = JSON.parse(io.readFileSync(intentPath, "utf8")); }
    catch {
      say("REFUND_VERIFY: UNKNOWN intent unreadable");
      return 3;
    }
    const chain = await resolveChain(deps);
    const client = deps.client ?? await openReadOnly(deps, owned); // GUARD:R3-no-build
    const { base, baseText } = chain;
    let hist;
    try { hist = await readHistory(client); }
    catch { hist = { error: true, capped: false, memos: [], staples: [] }; }
    const minutes = Math.max(0, Math.floor((now() - Date.parse(intent.published || 0)) / 60000));
    if (hist.error || hist.capped) {
      const why = hist.capped ? "history page cap" : "history read failed";
      say(`REFUND_VERIFY: UNKNOWN ${why} hash found unknown pending unknown balance ${intent.balanceBefore} now unknown minutes ${minutes}`); // GUARD:H1-history
      return 3;
    }
    let pending;
    let balance;
    try {
      pending = await client.pendingBlock();
      balance = await chainBalance(client, base);
    } catch {
      say(`REFUND_VERIFY: UNKNOWN history read failed hash found unknown pending unknown balance ${intent.balanceBefore} now unknown minutes ${minutes}`); // GUARD:H1-balance
      return 3;
    }
    const hit = findHash(hist, intent.block, base, baseText);
    const feeOk = hit.found && !hit.foreign && hit.fee <= REFUND_FEE_CAP;
    const pendingText = pending ? (hashText(pending.hash) || "pending") : "none";
    const before = BigInt(intent.balanceBefore);
    const total = BigInt(intent.rawTotal);
    const facts = `hash found ${hit.found ? "yes" : "no"} pending ${pendingText} balance ${show18(before)} now ${show18(balance)} minutes ${minutes}`;
    const state = classifyLanding({
      hashFound: hit.found,
      feeOk,
      pending: Boolean(pending),
      balance,
      before,
      total,
      fee: hit.fee,
    });
    if (state === "LANDED") {
      if (io.existsSync(`${bdir}/done.json`)) { // GUARD:R3-once
        let doneBody;
        try { doneBody = JSON.parse(io.readFileSync(`${bdir}/done.json`, "utf8")); }
        catch {
          say("REFUND_VERIFY: UNKNOWN done.json unreadable"); // GUARD:N3-unreadable
          return 3;
        }
        if (!doneBody || typeof doneBody !== "object" || Array.isArray(doneBody)) {
          say("REFUND_VERIFY: UNKNOWN done.json unreadable"); // GUARD:N3-unreadable
          return 3;
        }
        if (doneBody.books === "adjusted") { // GUARD:H2-verify-done
          say("REFUND_VERIFY: LANDED (already finished)");
          return 0;
        }
        if (doneBody.books === "mismatch") { // GUARD:H2-verify-mismatch
          say("REFUND_VERIFY: LANDED books not adjusted");
          return 3;
        }
        if (doneBody.books === "unconfirmed") { // GUARD:N3-unconfirmed
          say("REFUND_VERIFY: LANDED books written, not confirmed");
          return 3;
        }
        say("REFUND_VERIFY: UNKNOWN done.json books field missing or invalid"); // GUARD:N3-books
        return 3;
      }
      const shown = typeof intent.block === "string" && /^[0-9A-F]{64}$/.test(intent.block) ? intent.block : "unknown";
      let receiptNames;
      try { receiptNames = io.readdirSync(bdir); }
      catch { receiptNames = null; }
      if (!receiptNames || receiptNames.some((name) => String(name).startsWith("receipt-"))) {
        say(`REFUND_VERIFY: UNKNOWN_RECEIPT_NO_DONE ${shown}`);
        say("Stop. Do not adjust books. Send this output to Forge and KeeLend Ops.");
        return 4;
      }
      const code = finishBooks({ dir, now, say, intent, io, batch }, { fee: hit.fee, balance, stapleHash: hit.stapleHash, blockMs: hit.timeMs });
      if (code !== 0) return code;
      say("REFUND_VERIFY: LANDED (finished now)");
      return 0;
    }
    say(`REFUND_VERIFY: ${state} ${facts}`);
    return 3;
  }

  const runnerHook = typeof deps.procRootDir === "string" ? { procRootDir: deps.procRootDir } : {};
  const state = await valueOf(systemctl);
  if (state !== "inactive" && state !== "failed") return refuse("runner is active"); // GUARD:G1-systemctl
  let procs;
  try {
    procs = deps.processes !== undefined ? await valueOf(processes) : defaultProcesses(deps.procRoot);
  } catch (err) {
    if (err?.name === "ProcessListUnreadable") return refuse("process list unreadable"); // GUARD:N3
    throw err;
  }
  try {
  if ((procs ?? []).some((proc) => processIsRunner(proc, runnerHook))) return refuse("run.mjs is running"); // GUARD:G1-process
  } catch (err) {
    if (err?.name === "ProcessListUnreadable") return refuse("process list unreadable"); // GUARD:H3-resolve
    throw err;
  }
  for (const name of ["STOP", "HALT", "PAYHOLD", "FEEHOLD"]) {
    if (io.existsSync(`${dir}/${name}`)) return refuse(`${name} is present`); // GUARD:G2
  }
  if (io.existsSync(`${dir}/payout-intent.json`)) return refuse("payout-intent.json is present"); // GUARD:G2
  const priorIntent = `${bdir}/intent.json`;
  const priorDone = `${bdir}/done.json`;
  if (io.existsSync(priorIntent) || io.existsSync(priorDone)) { // GUARD:G3
    const path = io.existsSync(priorIntent) ? priorIntent : priorDone;
    const kind = io.existsSync(priorIntent) ? "intent" : "done";
    let note = "unknown total unknown";
    try {
      const body = JSON.parse(io.readFileSync(path, "utf8"));
      note = `${body.block ?? "unknown"} total ${body.total ?? "unknown"}`;
    } catch { /* keep unknown */ }
    return refuse(`prior refund ${kind} ${note}. Use --verify.`);
  }
  const R = `${dir}/refund`;
  const others = batch === "all"
    ? [`${R}/b1/intent.json`, `${R}/b1/done.json`, `${R}/b2/intent.json`, `${R}/b2/done.json`, `${R}/plan.json`]
    : batch === "1"
      ? [`${R}/intent.json`, `${R}/done.json`, `${R}/b2/intent.json`, `${R}/b2/done.json`, `${R}/plan.json`]
      : [`${R}/intent.json`, `${R}/done.json`];
  if (others.some((path) => io.existsSync(path))) return refuse("refund files from another batch are present. Use --verify."); // GUARD:W-state
  const recs = readRecords(io, dir);
  if (!recs.ok) return refuse(recs.why); // GUARD:W-rec-read
  if (batch !== "2" && recs.keys.length > 0) return refuse(`wallet records are present (${recs.keys.length})`); // GUARD:W-rec-empty
  let b1 = null;
  if (batch === "2") {
    const why = batchOneProblem(io, R, recs);
    if (why) return refuse(why);
    b1 = loadBatchOne(io, R);
  }

  const chainParts = await resolveChain(deps);
  let client = deps.client ?? await openReadOnly(deps, owned);
  const { base, baseText, accountFrom } = chainParts;
  const hist = await readHistory(client);
  if (hist.error) return refuse("history read failed");
  if (hist.capped) return refuse("history page cap hit before cutoff"); // GUARD:G3b-cap
  if (batch !== "2" && hist.memos.length > 0) return refuse(`refund memo already on chain in block ${hist.memos[0].hash}`); // GUARD:G3b-memo
  if (batch === "2" && !hist.memos.some((m) => m.hash === b1.intent.block && m.to === CANARY && m.amount === b1.amount)) return refuse("batch 1 is not on chain"); // GUARD:W-chain-b1
  let pending;
  try { pending = await client.pendingBlock(); }
  catch { return refuse("a block is already pending"); }
  if (pending) return refuse("a block is already pending"); // GUARD:G4

  let books;
  try { books = loadBooks(io, dir); }
  catch { return refuse("books are unreadable"); }
  const reserveAtCheck = books.share.reserve;
  let chain;
  try { chain = await chainBalance(client, base); }
  catch { return refuse("balance read failed"); }
  const booksTotal = accounted(books);
  if (booksTotal !== chain || (books.pendingDrops ?? []).length > 0) { // GUARD:G6
    if ((books.pendingDrops ?? []).length > 0 && booksTotal === chain) {
      return refuse(`pending drops are not empty. ${booksReason(booksTotal, chain)}`);
    }
    return refuse(booksReason(booksTotal, chain));
  }

  let drain;
  try { drain = readDrain(io, deps); }
  catch { return refuse("drain file hash does not match"); }
  const drainReason = drainProblem(drain, books);
  if (drainReason === "drain file hash does not match") return refuse(drainReason); // GUARD:G7-sha
  if (drainReason === "drain weights are not the pinned set" || drainReason === "drain key is excluded" || drainReason === "drain key is not in the books") { // GUARD:G7-set
    return refuse(drainReason);
  }
  if (drainReason === "drain weight is invalid") return refuse(drainReason); // GUARD:G7-weight
  if (drainReason === "drain total does not match") return refuse(drainReason); // GUARD:G7-total

  if (unpayableStake(books)) return refuse("unpayable stake"); // GUARD:G8

  let full;
  let planned;
  let preview = null;
  if (batch !== "2") {
    full = planOf(books, drain.parsed.weights);
    if (full.pool <= 0n) return refuse("pool is empty");
    if (Object.prototype.hasOwnProperty.call(deps, "plannerFault")) {
      if (deps.plannerFault === "excluded") full.rows.push({ key: TREY_A, stake: 0n, weight: "0", addback: 0n, amount: 1n });
      if (deps.plannerFault === "zero") full.rows.push({ key: PINNED[0], stake: 0n, weight: "0", addback: 0n, amount: 0n });
      if (deps.plannerFault === "total") full.total += 1n;
    }
    if (assertPlan(full.rows, full.total)) return refuse("plan assertion failed"); // GUARD:R7
    full.digest = digestOf(full.rows.filter((row) => row.amount > 0n));
    if (batch === "all") {
      planned = full;
    } else {
      const rows = full.rows.filter((row) => row.key === CANARY);
      if (rows.length !== 1) return refuse("canary row is missing");
      planned = sliceOf(full, rows);
      preview = sliceOf(full, full.rows.filter((row) => row.key !== CANARY));
    }
  } else {
    full = { ...b1.plan, digest: b1.plan.fullPlan };
    const planKeys = new Set(full.rows.map((row) => row.key));
    for (const [key, amount] of books.share.stake) {
      if (amount > 0n && !EXCLUDED.has(key) && !planKeys.has(key)) return refuse(`unplanned stake on ${key}`); // GUARD:W-unplanned
    }
    for (const key of [TREY_A, TREY_B, BRIDGE]) {
      if ((books.share.stake.get(key) ?? 0n) !== 0n) return refuse("excluded stake is not zero after batch 1"); // GUARD:W-excluded-zero
    }
    const rows = [];
    for (const row of full.rows) {
      if (recs.records.has(row.key)) continue; // GUARD:W-rec-skip
      const live = books.share.stake.get(row.key) ?? 0n;
      if (live > row.stake) return refuse(`stake grew since the plan on ${row.key}`); // GUARD:W-stake-grew
      const amount = live + row.addback;
      if (amount === 0n) continue;
      rows.push({ key: row.key, stake: live, weight: row.weight, addback: row.addback, amount });
    }
    planned = sliceOf(full, rows);
    if (assertPlan(planned.rows, planned.total)) return refuse("plan assertion failed");
    const keys = new Set(planned.rows.map((row) => row.key));
    if (hist.memos.some((m) => keys.has(m.to))) return refuse("a selected wallet already has a refund on chain"); // GUARD:W-chain-overlap
    if (hist.memos.some((m) => !(m.hash === b1.intent.block && m.to === CANARY))) return refuse("unexpected refund memo on chain"); // GUARD:W-chain-extra
  }
  let excludedNow = 0n;
  for (const key of EXCLUDED) excludedNow += books.share.stake.get(key) ?? 0n;
  const operatorShort = books.operator + excludedNow - planned.addbacks - REFUND_FEE_CAP < 0n;
  for (const row of planned.rows) {
    if (!(row.amount > 0n)) continue;
    try { accountFrom(row.key); } // GUARD:B1-decode
    catch { return refuse("address does not decode"); }
  }
  if (planned.rows.length === 0 || planned.rows.length > 50) return refuse("batch shape is wrong");

  if (mode === "no-quote") { // GUARD:no-quote-no-sign
    if (chain < planned.total + REFUND_FEE_CAP + RESERVE) return refuse("balance is short of the refund"); // GUARD:G11
    if (operatorShort) return refuse("operator would go negative"); // GUARD:W-operator
    for (const line of summaryLines(planned, books, "not quoted", chain, chain - planned.total - REFUND_FEE_CAP)) say(line);
    for (const line of batchLines(batch, full, preview)) say(line);
    say("REFUND_DRY_RUN_OK (no quote)");
    atomicWrite(io, `${dir}/refund/dryrun-${when}.txt`, `${lines.join("\n")}\n`);
    return 0;
  }

  const confirmTotal = flag(argv, "--confirm-total");
  const confirmCount = flag(argv, "--confirm-count");
  const confirmPlan = flag(argv, "--confirm-plan");
  // GUARD:H5
  if (mode === "send") {
    if (confirmTotal === undefined || confirmCount === undefined || confirmTotal !== show18(planned.total) || confirmCount !== String(planned.rows.length)) { // GUARD:G12-total
      if (confirmTotal === undefined || confirmCount === undefined) return refuse("confirm flags are missing");
      if (confirmTotal !== show18(planned.total)) return refuse("confirm total does not match");
      return refuse("confirm count does not match");
    }
    if (confirmPlan === undefined || confirmPlan !== planned.digest) { // GUARD:G12-plan
      if (confirmPlan === undefined) return refuse("confirm flags are missing");
      return refuse("confirm plan does not match");
    }
    const confirmFull = flag(argv, "--confirm-full");
    if (batch !== "all" && confirmFull !== full.digest) { // GUARD:W-confirm-full
      if (confirmFull === undefined) return refuse("confirm flags are missing");
      return refuse("confirm full plan does not match");
    }
  }

  const loadWallet = deps.loadWallet ?? ((walletDir) => defaultLoadWallet(walletDir, io));
  let wallet;
  try { wallet = await loadWallet(dir); }
  catch { return refuse("seed is not the intake wallet"); }
  const walletKey = accountKey(wallet?.publicKeyString) || accountKey(wallet);
  if (walletKey !== INTAKE) return refuse("seed is not the intake wallet"); // GUARD:G5
  if (!deps.client) client = await openSigning(deps, owned, wallet); // GUARD:B1-signing

  const builder = client.initBuilder();
  for (const row of planned.rows) builder.send(accountFrom(row.key), row.amount, base, MEMO);
  let computed;
  try { computed = await builder.computeBlocks(); }
  catch { return refuse("batch shape is wrong"); }
  const block = computed?.blocks?.[0];
  if (!computed?.blocks || computed.blocks.length !== 1 || batchProblem(block, planned.rows, planned.total, base, baseText)) {
    return refuse("batch shape is wrong"); // GUARD:G9
  }
  if (!hashText(block.hash)) return refuse("batch shape is wrong"); // GUARD:S6

  let quotes;
  try { quotes = await client.getQuotes(computed.blocks); }
  catch { return refuse("quote is unusable"); }
  const quoted = judgeVotes(quotes, base, baseText);
  if (!quoted.usable) return refuse("quote is unusable");
  if (quoted.foreign) return refuse("quote is non-KTA");
  if (quoted.kta > REFUND_FEE_CAP) return refuse("quote is over the refund fee cap"); // GUARD:G10-quote
  const { generateFeeBlock, taken } = makeFee(client, base, baseText);
  if (chain < planned.total + REFUND_FEE_CAP + RESERVE) return refuse("balance is short of the refund"); // GUARD:G11-quoted
  if (operatorShort) return refuse("operator would go negative"); // GUARD:W-operator-quoted

  const feeText = show18(quoted.kta);
  for (const line of summaryLines(planned, books, feeText, chain, chain - planned.total - quoted.kta)) say(line);
  for (const line of batchLines(batch, full, preview)) say(line);
  if (mode !== "send") { // GUARD:dry-run-no-publish
    let again = null;
    let pendingUnknown = false;
    try { again = await client.pendingBlock(); } // GUARD:S2
    catch { pendingUnknown = true; }
    if (pendingUnknown) {
      say("Pending block after quote: unknown");
      say("REFUND_CHECK: pending block after quote");
    } else if (again) {
      say(`Pending block after quote: ${hashText(again.hash) || "pending"}`);
      say("REFUND_CHECK: pending block after quote");
    } else {
      say("Pending block after quote: none");
    }
    say("REFUND_DRY_RUN_OK");
    atomicWrite(io, `${dir}/refund/dryrun-${when}.txt`, `${lines.join("\n")}\n`);
    return 0;
  }

  let stopFd;
  try {
    stopFd = io.openSync(`${dir}/STOP`, "wx", 0o600); // GUARD:R4-exclusive
    stopOpen = true;
  } catch {
    return refuse("STOP already exists");
  }
  try {
    io.writeFileSync(stopFd, "refund in progress\n");
    io.fsyncSync(stopFd);
  } finally { io.closeSync(stopFd); }
  io.chmodSync(`${dir}/STOP`, 0o600);

  const stateAgain = await valueOf(systemctl);
  if (stateAgain !== "inactive" && stateAgain !== "failed") return refuse("runner is active"); // GUARD:R4-recheck
  let procsAgain;
  try {
    procsAgain = deps.processes !== undefined ? await valueOf(processes) : defaultProcesses(deps.procRoot); // GUARD:F2
  } catch (err) {
    if (err?.name === "ProcessListUnreadable") return refuse("process list unreadable"); // GUARD:F2
    throw err;
  }
  try {
  if ((procsAgain ?? []).some((proc) => processIsRunner(proc, runnerHook))) return refuse("run.mjs is running"); // GUARD:R4-recheck
  } catch (err) {
    if (err?.name === "ProcessListUnreadable") return refuse("process list unreadable"); // GUARD:H3-resolve-recheck
    throw err;
  }
  let pendingAgain;
  try { pendingAgain = await client.pendingBlock(); }
  catch { return refuse("a block is already pending"); }
  if (pendingAgain) return refuse("a block is already pending"); // GUARD:R4-recheck
  let chainAgain;
  try { chainAgain = await chainBalance(client, base); }
  catch { return refuse("balance read failed"); }
  const booksAgain = loadBooks(io, dir);
  const againTotal = accounted(booksAgain);
  if (againTotal !== chainAgain || (booksAgain.pendingDrops ?? []).length > 0) {
    return refuse(booksReason(againTotal, chainAgain)); // GUARD:R4-recheck
  }
  if (chainAgain < planned.total + REFUND_FEE_CAP + RESERVE) {
    return refuse("balance is short of the refund"); // GUARD:R4-recheck
  }

  const intent = {
    block: hashText(block.hash),
    recipients: planned.rows.map((row) => ({
      key: row.key,
      amount: row.amount.toString(),
      stake: row.stake.toString(),
      weight: row.weight,
      addback: row.addback.toString(),
    })),
    total: show18(planned.total),
    rawTotal: planned.total.toString(),
    count: planned.rows.length,
    plan: planned.digest,
    fee: quoted.kta.toString(),
    addbacks: planned.addbacks.toString(),
    balanceBefore: chainAgain.toString(),
    floor: (chainAgain - planned.total).toString(),
    published: stamp(now()),
    batch,
    fullPlan: full.digest,
  };
  const batchDir = ensureBatchDir(io, dir, batch);
  if (batch === "1") {
    const frozen = {
      fullPlan: full.digest,
      pool: full.pool.toString(),
      addbacks: full.addbacks.toString(),
      total: full.total.toString(),
      rows: full.rows.map((row) => ({ key: row.key, stake: row.stake.toString(), weight: row.weight, addback: row.addback.toString(), amount: row.amount.toString() })),
    };
    exclusiveWrite(io, `${dir}/refund/plan.json`, `${JSON.stringify(frozen, null, 2)}\n`); // GUARD:W-plan-write
  }
  const walletsDir = `${dir}/refund/wallets`;
  io.mkdirSync(walletsDir, { recursive: true, mode: 0o700 });
  io.chmodSync(walletsDir, 0o700);
  for (const row of planned.rows) {
    const record = { key: row.key, batch, block: intent.block, amount: row.amount.toString(), at: intent.published };
    exclusiveWrite(io, `${walletsDir}/${row.key}.json`, `${JSON.stringify(record, null, 2)}\n`); // GUARD:W-rec-write
  }
  fsyncDir(io, walletsDir);
  atomicWrite(io, `${batchDir}/intent.json`, `${JSON.stringify(intent, null, 2)}\n`); // GUARD:R4-intent-before-publish
  let published;
  try {
    published = await client.publishBuilder(builder, { generateFeeBlock, quotes });
  } catch (err) {
    say(`REFUND_HOLD: publish error ${err instanceof Error ? err.name : "Error"}`);
    return 3;
  }
  const hashes = publishedHashes(published);
  if (!hashes.includes(intent.block)) { // GUARD:R1-published-hash
    say("REFUND_HOLD: published staple does not contain the block");
    return 3;
  }
  const landedHist = await readHistory(client);
  if (landedHist.error || landedHist.capped) {
    say("REFUND_HOLD: history read failed");
    return 3;
  }
  let pendingLand = null;
  let balanceLand;
  try {
    pendingLand = await client.pendingBlock();
    balanceLand = await chainBalance(client, base);
  } catch {
    say("REFUND_HOLD: history read failed");
    return 3;
  }
  const hit = findHash(landedHist, intent.block, base, baseText);
  const fee = hit.found ? hit.fee : 0n;
  const feeOk = hit.found && !hit.foreign && fee <= REFUND_FEE_CAP && (!taken.used || fee === taken.fee);
  const pendingText = pendingLand ? (hashText(pendingLand.hash) || "pending") : "none";
  const fact = `hash found ${hit.found ? "yes" : "no"} pending ${pendingText} balance ${show18(chainAgain)} now ${show18(balanceLand)}`;
  const expected = chainAgain - planned.total - fee;
  const landed = hit.found && feeOk && !pendingLand && balanceLand === expected; // GUARD:R1-landed
  if (landed) {
    const code = finishBooks({ dir, now, say, intent, io, batch, reserveBefore: reserveAtCheck }, { fee, balance: balanceLand, stapleHash: hit.stapleHash, blockMs: hit.timeMs });
    if (code !== 0) return code;
    say("REFUND_SENT_OK");
    return 0;
  }
  const landing = classifyLanding({
    hashFound: hit.found,
    feeOk,
    pending: Boolean(pendingLand),
    balance: balanceLand,
    before: chainAgain,
    total: planned.total,
    fee,
  });
  if (landing === "NOT_LANDED") {
    say(`REFUND_NOT_LANDED: ${fact}`);
    return 3;
  }
  if (landing === "PENDING") {
    say(`REFUND_PENDING: ${fact}`);
    return 3;
  }
  say(`REFUND_HOLD: ${fact}`); // GUARD:R1-balance-only
  return 3;
  } catch (err) {
    const name = err instanceof Error && err.name ? err.name : "Error";
    if (mode === "verify") { // GUARD:F3
      say(`REFUND_VERIFY: UNKNOWN unexpected ${name}`);
      return 3;
    }
    if (mode === "check") {
      say(`REFUND_BATCH_NOT_VERIFIED: unexpected ${name}`);
      return 3;
    }
    if (stopOpen) { // GUARD:S3-after
      say(`REFUND_HOLD: unexpected ${name}`);
      return 3;
    }
    say(`REFUND_REFUSED: unexpected ${name}`); // GUARD:S3-before
    return 2;
  } finally {
    for (const created of owned) {
      try { await created.destroy?.(); } catch { /* the one-shot script is leaving */ }
    }
  }
}

function sdkParts(KeetaNet) {
  const base = KeetaNet.lib.Account.generateBaseAddresses(0x5382n).baseToken;
  const baseText = base.publicKeyString.toString();
  const accountFrom = (id) => KeetaNet.lib.Account.fromPublicKeyString(id);
  return { base, baseText, accountFrom };
}

async function resolveChain(deps) {
  let base = deps.base;
  let baseText = deps.baseText;
  let accountFrom = deps.accountFrom;
  if (base === undefined || baseText === undefined || accountFrom === undefined) {
    const KeetaNet = await import("@keetanetwork/keetanet-client");
    const parts = sdkParts(KeetaNet);
    if (base === undefined) base = parts.base;
    if (baseText === undefined) baseText = parts.baseText;
    if (accountFrom === undefined) accountFrom = parts.accountFrom;
  }
  return { base, baseText, accountFrom };
}

async function openReadOnly(deps, owned) {
  const client = await (deps.clientFactory ?? defaultClientFactory)({ readOnly: true });
  owned.push(client);
  return client;
}

async function openSigning(deps, owned, wallet) {
  const client = await (deps.clientFactory ?? defaultClientFactory)({ readOnly: false, wallet });
  owned.push(client);
  return client;
}

async function defaultLoadWallet(dir, io) {
  const phrase = io.readFileSync(`${dir}/seed.txt`, "utf8").trim().toLowerCase().replace(/\s+/g, " ");
  const KeetaNet = await import("@keetanetwork/keetanet-client");
  const hex = await KeetaNet.lib.Account.seedFromPassphrase(phrase, { asString: true });
  return KeetaNet.lib.Account.fromSeed(String(hex), 0);
}

async function defaultClientFactory({ readOnly, wallet } = {}) {
  const KeetaNet = await import("@keetanetwork/keetanet-client");
  if (readOnly) {
    const account = KeetaNet.lib.Account.fromPublicKeyString(INTAKE);
    // Signer null is the SDK's read-only client. The account option supplies
    // the intake address for balance, history and pending reads.
    return KeetaNet.UserClient.fromNetwork("main", null, { account });
  }
  return KeetaNet.UserClient.fromNetwork("main", wallet);
}

function startedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  const code = await main();
  process.exit(code);
}

export { main, DRAIN_SHA256, DRAIN_TOTAL, REFUND_FEE_CAP, MEMO, INTAKE, EXCLUDED };
