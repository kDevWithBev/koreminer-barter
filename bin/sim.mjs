import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeAtomic } from "../src/atomic.mjs";
import { assertOutsideRunner, loadWalletHistory } from "../src/history.mjs";
import { buildPublicLadder } from "../src/ladder.mjs";
import { publishNight, runNightly } from "../src/nightly.mjs";

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

function main() {
  if (process.argv.includes("--ladder")) {
    const lookupPath = arg("--lookup");
    if (!lookupPath) throw new Error("missing --lookup");
    const lookupFile = resolve(lookupPath);
    if (lookupFile === "/opt/koreminer" || lookupFile.startsWith("/opt/koreminer/")) {
      throw new Error("lookup path refused");
    }
    const historyDir = assertOutsideRunner(arg("--history") ?? resolve("data/history"));
    const publicDir = assertOutsideRunner(arg("--public") ?? resolve("public/barter"));
    const lookup = readJson(lookupPath);
    const history = loadWalletHistory(historyDir);
    const ladder = buildPublicLadder({ miners: lookup.miners ?? {}, history });
    writeAtomic(publicDir, "ladder.json", `${JSON.stringify(ladder, null, 2)}\n`);
    process.stdout.write(`${publicDir}/ladder.json\n`);
    return;
  }

  if (process.argv.includes("--nightly")) {
    const lookupPath = arg("--lookup");
    const historyArg = arg("--history");
    const publicArg = arg("--public");
    const outcome = runNightly({
      ...(lookupPath ? { lookupPath } : {}),
      ...(historyArg ? { historyDir: assertOutsideRunner(historyArg) } : {}),
      ...(publicArg ? { publicDir: assertOutsideRunner(publicArg) } : {}),
    });
    if (!outcome.skipped) process.stdout.write(`${outcome.night}\n`);
    return;
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
  }

  publishNight({ night, lookup, input, historyDir, publicDir });
  process.stdout.write(`${publicDir}/calls/${night}.json\n`);
}

main();
