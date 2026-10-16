import { existsSync, readFileSync, statSync } from "node:fs";
import { runCall } from "./engine.mjs";
import { ensureHistory, loadWalletHistory } from "./history.mjs";
import { buildPublicLadder } from "./ladder.mjs";
import { writeAtomic } from "./atomic.mjs";

export const LOOKUP_PATH = "/var/www/koreminer/lookup.json";
export const HISTORY_DIR = "/opt/koreminer-barter/data/history";
export const PUBLIC_DIR = "/var/www/koreminer/barter";
export const LOOKUP_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDate(ms) {
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

export function closeInstant(now = Date.now()) {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return date.getTime() < midnight ? midnight - DAY_MS : midnight;
}

export function nightJustClosed(now = Date.now()) {
  return utcDate(closeInstant(now) - DAY_MS);
}

export function payoutLanded(lookup, closeMs) {
  const updated = Date.parse(lookup?.updated ?? "");
  return Number.isFinite(updated) && updated >= closeMs;
}

export function lookupSkip(stat, now = Date.now()) {
  if (!stat) return "Skip. Lookup is missing.";
  if (now - stat.mtimeMs > LOOKUP_MAX_AGE_MS) return "Skip. Lookup is stale.";
  return null;
}

function withMined(input, lookup) {
  const mined = { ...(input.mined ?? {}) };
  for (const [wallet, row] of Object.entries(lookup?.miners ?? {})) {
    if (mined[wallet]) continue;
    mined[wallet] = {
      streak: Number(row.streak) || 0,
      shieldDays: 0,
      kore: Number(row.paid) + Number(row.waiting),
    };
  }
  return { ...input, mined };
}

export function emptyNight(night) {
  return {
    night,
    intents: [],
    house: { kta: 0, kore: 0 },
    balances: {},
    confirms: null,
    costToMine: [],
    history: {},
    barterers: [],
  };
}

export function publishNight({ night, lookup, input, historyDir, publicDir }) {
  const result = runCall(withMined(input, lookup));
  let seeded = false;
  let appended = false;
  if (lookup) {
    const recorded = ensureHistory({ dir: historyDir, night, lookup });
    seeded = recorded.seeded;
    appended = recorded.appended;
    const history = loadWalletHistory(historyDir);
    const ladder = buildPublicLadder({ miners: lookup.miners ?? {}, history });
    writeAtomic(publicDir, "ladder.json", `${JSON.stringify(ladder, null, 2)}\n`);
  }
  const body = `${JSON.stringify(result.publicCall, null, 2)}\n`;
  writeAtomic(publicDir, "call-latest.json", body);
  writeAtomic(publicDir, `calls/${night}.json`, body);
  return { result, seeded, appended };
}

export function runNightly({
  now = Date.now(),
  lookupPath = LOOKUP_PATH,
  historyDir = HISTORY_DIR,
  publicDir = PUBLIC_DIR,
  input = null,
  log = console.log,
} = {}) {
  const night = nightJustClosed(now);
  let stat = null;
  if (existsSync(lookupPath)) stat = statSync(lookupPath);
  const reason = lookupSkip(stat, now);
  if (reason) {
    log(reason);
    return { ok: true, skipped: true, night, seeded: false, appended: false };
  }
  const lookup = JSON.parse(readFileSync(lookupPath, "utf8"));
  if (!payoutLanded(lookup, closeInstant(now))) {
    log("Skip. Payout has not landed.");
    return { ok: true, skipped: true, night, seeded: false, appended: false };
  }
  const published = publishNight({
    night,
    lookup,
    input: { ...(input ?? emptyNight(night)), night },
    historyDir,
    publicDir,
  });
  return { ok: true, skipped: false, night, seeded: published.seeded, appended: published.appended };
}
