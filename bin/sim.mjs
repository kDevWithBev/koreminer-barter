import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runCall } from "../src/engine.mjs";
import { assertOutsideRunner, ensureHistory, loadWalletHistory } from "../src/history.mjs";
import { buildPublicLadder } from "../src/ladder.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const night = arg("--night");
if (!night) throw new Error("missing --night");

let input;
const inputPath = arg("--input");
if (inputPath) {
  input = readJson(inputPath);
} else {
  const intentsPath = arg("--intents") ?? `fixtures/intents-${night}.json`;
  input = readJson(intentsPath);
}
input.night = night;

const publicDir = assertOutsideRunner(arg("--public") ?? resolve("public/barter"));
const historyDir = assertOutsideRunner(arg("--history") ?? resolve("data/history"));

const lookupPath = arg("--lookup");
let lookup = null;
if (lookupPath) {
  const lookupFile = resolve(lookupPath);
  if (lookupFile === "/opt/koreminer" || lookupFile.startsWith("/opt/koreminer/")) {
    throw new Error("lookup path refused");
  }
  lookup = readJson(lookupPath);
  input.mined = input.mined ?? {};
  for (const [wallet, row] of Object.entries(lookup.miners ?? {})) {
    if (input.mined[wallet]) continue;
    input.mined[wallet] = {
      streak: Number(row.streak) || 0,
      shieldDays: 0,
      kore: Number(row.paid) + Number(row.waiting),
    };
  }
}

const result = runCall(input);
if (lookup) {
  ensureHistory({ dir: historyDir, night, lookup });
  const history = loadWalletHistory(historyDir);
  const ladder = buildPublicLadder({ miners: lookup.miners, history });
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, "ladder.json"), `${JSON.stringify(ladder, null, 2)}\n`);
}

const latest = join(publicDir, "call-latest.json");
const dated = join(publicDir, "calls", `${night}.json`);
for (const path of [latest, dated]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result.publicCall, null, 2)}\n`);
}
process.stdout.write(`${dated}\n`);
