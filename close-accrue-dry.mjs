// Read-only close credit. No network. Never imports run.mjs.
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { booksFromJson } from "./books.mjs";
import { dayStart } from "./ledger.mjs";
import { accrue, due } from "./share.mjs";

const DAY_MS = 86_400_000;
const UNIT = 1_000_000_000_000n;
const HELD = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const INTAKE = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const SINK = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";

function fail(err) {
  const name = err instanceof Error && err.name ? err.name : "Error";
  console.log(`CLOSE_DRY_FAIL ${name}`);
  process.exit(1);
}

function kore6(units) {
  const neg = units < 0n;
  const value = neg ? -units : units;
  const whole = value / UNIT;
  const frac = (value % UNIT).toString().padStart(12, "0").slice(0, 6);
  return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
}

function pendingTotal(share) {
  let sum = 0n;
  for (const amount of share.pending.values()) sum += amount;
  return sum;
}

function nextEdge(now) {
  return dayStart(now) + DAY_MS;
}

function payable(address) {
  if (address === INTAKE || address === SINK || address === HELD) return false;
  return String(address).startsWith("keeta_");
}

try {
  const file = process.argv[2];
  if (!file) throw new Error("missing books");
  const edgeArg = process.argv[3];
  const now = Date.now();
  const edge = edgeArg ? Date.parse(edgeArg) : nextEdge(now);
  if (!Number.isFinite(edge)) {
    const err = new Error("bad edge");
    err.name = "RangeError";
    throw err;
  }
  const fd = openSync(file, "r");
  let books;
  try {
    books = booksFromJson(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
  const clone = structuredClone(books);
  const before = new Map();
  for (const address of new Set([...clone.share.stake.keys(), ...clone.share.pending.keys(), HELD])) {
    before.set(address, due(clone.share, address));
  }
  const pendingBefore = pendingTotal(clone.share);
  const nothing = clone.share.lastMs >= edge;
  if (!nothing) accrue(clone.share, edge);
  const credit = pendingTotal(clone.share) - pendingBefore;
  const rows = [];
  const seen = new Set([...before.keys(), ...clone.share.pending.keys(), ...clone.share.stake.keys()]);
  for (const address of seen) {
    const owed = before.get(address) ?? 0n;
    const atClose = due(clone.share, address);
    if (atClose <= 0n) continue;
    rows.push({ address, owed, credit: atClose - owed, atClose });
  }
  rows.sort((a, b) => {
    if (a.atClose !== b.atClose) return a.atClose > b.atClose ? -1 : 1;
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0;
  });
  let owedSum = 0n;
  let dueSum = 0n;
  let wallets = 0;
  console.log(`CLOSE_DRY ${new Date(now).toISOString()}`);
  console.log(`LASTMS ${new Date(books.share.lastMs).toISOString()}`);
  console.log(`EDGE ${new Date(edge).toISOString()}`);
  rows.forEach((row, index) => {
    owedSum += row.owed;
    console.log(`${index + 1} ${row.address} owed ${row.owed} credit ${row.credit} due ${row.atClose}`);
  });
  for (const row of rows) {
    if (row.address === HELD) continue;
    dueSum += row.atClose;
    if (payable(row.address)) wallets += 1;
  }
  console.log(`HELD ${HELD} ${due(clone.share, HELD)}`);
  console.log(`TOTAL_OWED_NOW ${owedSum}`);
  console.log(`TOTAL_CREDIT ${kore6(credit)}`);
  console.log(`TOTAL_DUE_AT_CLOSE ${dueSum}`);
  console.log(`WALLETS ${wallets}`);
  if (nothing) console.log("NOTHING_TO_CREDIT");
  console.log("CLOSE_DRY_OK");
} catch (err) {
  fail(err);
}
