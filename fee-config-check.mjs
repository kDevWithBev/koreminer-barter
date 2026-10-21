import { bundleCap, configLine, fromKta, maxBlocksPerHour } from "./pace.mjs";
import { makeBooks, makeClient, runCase } from "./fee-harness.mjs";
process.env.PICKS_OFF = "0"; // fix/rate-hold r2: picks run only with PICKS_OFF=0 (missing or empty now means off)

// fix/rate-hold: hard ceilings 0.05 KTA a block and 60 ledger blocks an hour; env can lower, never raise.
const HARD = " Hard limits 0.05000 KTA a block, 60 ledger blocks an hour, payout 0.05000 KTA a block and 0.50000 KTA a day.";
const DEFAULT = "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour." + HARD + " Picks on.";
const STARTUP = "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour." + HARD + " Last hour 0 ledger blocks. Picks on.";
let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

const savedCap = process.env.FEE_CAP_PER_BUNDLE_KTA;
const savedRate = process.env.MAX_BLOCKS_PER_HOUR;

function setEnv(cap, rate) {
  if (cap === undefined) delete process.env.FEE_CAP_PER_BUNDLE_KTA;
  else process.env.FEE_CAP_PER_BUNDLE_KTA = cap;
  if (rate === undefined) delete process.env.MAX_BLOCKS_PER_HOUR;
  else process.env.MAX_BLOCKS_PER_HOUR = rate;
}

function linesOf(logs) {
  return logs.filter((line) => line.startsWith("Config fee cap "));
}

try {
  setEnv(undefined, undefined);
  check("missing config uses the defaults", configLine() === DEFAULT && bundleCap() === fromKta("0.05") && maxBlocksPerHour() === 60, configLine());

  setEnv("", "");
  check("empty config uses the defaults", configLine() === DEFAULT && bundleCap() === fromKta("0.05") && maxBlocksPerHour() === 60, configLine());

  setEnv("nope", "lots");
  check("bad config uses the defaults", configLine() === DEFAULT && bundleCap() === fromKta("0.05") && maxBlocksPerHour() === 60, configLine());

  setEnv("0", "0");
  check("a zero config keeps the default numbers and turns picks off", configLine() === "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour." + HARD + " Picks off." && bundleCap() === fromKta("0.05") && maxBlocksPerHour() === 60, configLine());

  setEnv("0.05", "60");
  check("the top of the range is not a clamp", configLine() === DEFAULT && bundleCap() === fromKta("0.05") && maxBlocksPerHour() === 60, configLine());

  setEnv("0.02", "30");
  check("the env can lower the caps", configLine() === "Config fee cap 0.02000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 30 blocks an hour." + HARD + " Picks on." && bundleCap() === fromKta("0.02") && maxBlocksPerHour() === 30, configLine());

  setEnv("0.5", "600");
  check("0.5 and 600 are clamped to the hard 0.05 and 60", configLine() === "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour. (clamped from 0.50000 KTA, 600/hour)" + HARD + " Picks on." && bundleCap() === fromKta("0.05") && maxBlocksPerHour() === 60, configLine());

  setEnv("0.6", "900");
  check("a high config is clamped and the clamp is logged", configLine() === "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour. (clamped from 0.60000 KTA, 900/hour)" + HARD + " Picks on." && bundleCap() === fromKta("0.05") && maxBlocksPerHour() === 60, configLine());

  setEnv("9", undefined);
  check("only a high fee cap is marked", configLine() === "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour. (clamped from 9.00000 KTA)" + HARD + " Picks on.", configLine());

  setEnv(undefined, "1000");
  check("only a high block rate is marked", configLine() === "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour. (clamped from 1000/hour)" + HARD + " Picks on.", configLine());

  setEnv(undefined, undefined);
  const plainBooks = makeBooks(false);
  const plain = await runCase({
    books: plainBooks,
    client: makeClient(plainBooks, { pickQuote: fromKta("0.006") }),
    steps: 1,
  });
  const plainLines = linesOf(plain.logs);
  check("startup logs the config once", plainLines.length === 1 && plainLines[0] === STARTUP, plainLines.join("\n"));

  setEnv("1.2", "5000");
  const highBooks = makeBooks(false);
  const high = await runCase({
    books: highBooks,
    client: makeClient(highBooks, { pickQuote: fromKta("0.006") }),
    steps: 0,
  });
  const highLines = linesOf(high.logs);
  check("startup logs a clamp once", highLines.length === 1 && highLines[0] === "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour. (clamped from 1.20000 KTA, 5000/hour)" + HARD + " Last hour 0 ledger blocks. Picks on.", highLines.join("\n"));
} finally {
  if (savedCap === undefined) delete process.env.FEE_CAP_PER_BUNDLE_KTA;
  else process.env.FEE_CAP_PER_BUNDLE_KTA = savedCap;
  if (savedRate === undefined) delete process.env.MAX_BLOCKS_PER_HOUR;
  else process.env.MAX_BLOCKS_PER_HOUR = savedRate;
}
console.log("fee-config checks", passed);
