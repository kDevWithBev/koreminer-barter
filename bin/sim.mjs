import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertOutsideRunner } from "../src/history.mjs";
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
