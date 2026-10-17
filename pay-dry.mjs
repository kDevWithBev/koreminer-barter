// Read a copy of the books and list the nightly payout. Sends nothing.
import { readFileSync } from "node:fs";
import { booksFromJson } from "./books.mjs";
import { DAY_MS, dayStart } from "./ledger.mjs";
import { choosePayout } from "./pay.mjs";
import { accrue, due } from "./share.mjs";

const intake = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const sink = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const BRIDGE = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const SHAFT = "fe6d5e3f8cff2dc8d2dea137c87f721c69343d7d";

export function payoutList(share) {
  const rows = [];
  const skip = [];
  while (rows.length < 10_000) {
    const row = choosePayout(share, { intake, sink, skip });
    if (!row) break;
    rows.push(row);
    skip.push(row.from);
  }
  return rows;
}

export function dryRunText(books) {
  const next = dayStart(books.share.lastMs) + DAY_MS;
  if (next > books.share.lastMs) accrue(books.share, next);
  const rows = payoutList(books.share);
  let total = 0n;
  let independent = 0n;
  for (const from of books.share.pending.keys()) {
    if (from === intake || from === sink || from === BRIDGE) continue;
    if (!String(from).startsWith("keeta_")) continue;
    independent += due(books.share, from);
  }
  for (const row of rows) total += row.amount;
  const shaft = rows.some((row) => String(row.from).toLowerCase().includes(SHAFT));
  const bridge = rows.some((row) => row.from === BRIDGE);
  const hex = rows.some((row) => String(row.from).startsWith("0x") || String(row.from).startsWith("base:"));
  const lines = [
    "DRY RUN. Nothing will be sent.",
    `total KORE: ${total}`,
    `wallets: ${rows.length}`,
    `sum check: ${total === independent ? "ok" : "BAD"}`,
    `no shaft 0xfe6d: ${shaft ? "FAIL" : "ok"}`,
    `no bridge: ${bridge ? "FAIL" : "ok"}`,
    `no 0x: ${hex ? "FAIL" : "ok"}`,
  ];
  for (const row of rows) lines.push(`${row.from} ${row.amount}`);
  return `${lines.join("\n")}\n`;
}

export function runDry(argv) {
  const flag = argv.indexOf("--dry-run");
  const path = flag >= 0 ? argv[flag + 1] : "";
  if (!path || path.startsWith("-")) {
    console.log("DRY RUN. Nothing will be sent.");
    console.log("Usage: node pay-dry.mjs --dry-run books.copy.json");
    return;
  }
  const books = booksFromJson(JSON.parse(readFileSync(path, "utf8")));
  console.log(dryRunText(books).trimEnd());
}

if (process.argv[1] && process.argv[1].endsWith("pay-dry.mjs")) runDry(process.argv);
