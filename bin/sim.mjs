import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runCall } from "../src/engine.mjs";

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

const lookupPath = arg("--lookup");
if (lookupPath) {
  const lookup = readJson(lookupPath);
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
const latest = resolve("public/barter/call-latest.json");
const dated = resolve(`public/barter/calls/${night}.json`);
for (const path of [latest, dated]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result.publicCall, null, 2)}\n`);
}
process.stdout.write(`${dated}\n`);
