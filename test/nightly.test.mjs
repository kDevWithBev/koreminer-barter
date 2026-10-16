import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { writeAtomic } from "../src/atomic.mjs";
import { LOOKUP_MAX_AGE_MS, lookupSkip, nightJustClosed, payoutLanded, publishNight, runNightly } from "../src/nightly.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const HOUR = 60 * 60 * 1000;

function lookupFile(dir, miners, ageMs = 0, now = Date.now(), updated = new Date(now).toISOString()) {
  const path = join(dir, "lookup.json");
  writeFileSync(path, `${JSON.stringify({ updated, miners })}\n`);
  const when = (now - ageMs) / 1000;
  utimesSync(path, when, when);
  return path;
}

test("the night that just closed is the previous UTC date", () => {
  assert.equal(nightJustClosed("2026-10-17T00:05:00.000Z"), "2026-10-16");
  assert.equal(nightJustClosed("2026-10-17T00:00:00.000Z"), "2026-10-16");
  assert.equal(nightJustClosed("2026-10-17T06:00:00.000Z"), "2026-10-16");
  assert.equal(nightJustClosed("2026-11-01T00:05:00.000Z"), "2026-10-31");
  assert.equal(nightJustClosed("2026-01-01T00:05:00.000Z"), "2025-12-31");
});

test("a missing or stale lookup is skipped and a two-hour lookup is kept", () => {
  const now = Date.parse("2026-10-17T00:05:00.000Z");
  assert.equal(lookupSkip(null, now), "Skip. Lookup is missing.");
  assert.equal(lookupSkip({ mtimeMs: now - LOOKUP_MAX_AGE_MS }, now), null);
  assert.equal(lookupSkip({ mtimeMs: now - LOOKUP_MAX_AGE_MS - 1 }, now), "Skip. Lookup is stale.");

  const dir = mkdtempSync(join(tmpdir(), "kore-stale-"));
  const historyDir = join(dir, "history");
  const publicDir = join(dir, "public");
  const lines = [];
  const missing = runNightly({
    now,
    lookupPath: join(dir, "missing.json"),
    historyDir,
    publicDir,
    log: (line) => lines.push(line),
  });
  assert.equal(missing.skipped, true);
  assert.equal(missing.night, "2026-10-16");
  assert.equal(lines[0], "Skip. Lookup is missing.");
  assert.equal(existsSync(join(historyDir, "seed.json")), false);

  const stalePath = lookupFile(dir, { keeta_one: { fuel: "1", streak: 3 } }, 3 * HOUR, Date.now());
  const before = readFileSync(stalePath);
  const stale = runNightly({
    now: Date.now(),
    lookupPath: stalePath,
    historyDir,
    publicDir,
    log: (line) => lines.push(line),
  });
  assert.equal(stale.skipped, true);
  assert.equal(lines.at(-1), "Skip. Lookup is stale.");
  assert.equal(readFileSync(stalePath).equals(before), true);
  assert.equal(existsSync(join(publicDir, "call-latest.json")), false);
  assert.equal(existsSync(join(publicDir, "index.html")), false);
});

test("public files are replaced whole and the page file is left alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "kore-atomic-"));
  writeFileSync(join(dir, "call-latest.json"), "OLD");
  writeAtomic(dir, "call-latest.json", "{\"mode\":\"dry_run\"}\n");
  assert.equal(readFileSync(join(dir, "call-latest.json"), "utf8"), "{\"mode\":\"dry_run\"}\n");
  assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  writeAtomic(dir, "calls/2026-10-16.json", "{\"night\":\"2026-10-16\"}\n");
  assert.equal(JSON.parse(readFileSync(join(dir, "calls/2026-10-16.json"), "utf8")).night, "2026-10-16");
  assert.throws(() => writeAtomic(dir, "../nope.json", "no"));
  assert.throws(() => writeAtomic("/opt/koreminer/public", "call-latest.json", "no"));

  const publicDir = join(dir, "out");
  const historyDir = join(dir, "history");
  writeFileSync(join(dir, "page-holder"), "x");
  const page = join(publicDir, "index.html");
  const lookup = { miners: { keeta_one: { fuel: "1.00000", streak: 4, paid: "1", waiting: "0" } } };
  publishNight({
    night: "2026-10-16",
    lookup,
    input: {
      night: "2026-10-16",
      intents: [],
      house: { kta: 0, kore: 0 },
      balances: {},
      costToMine: [],
    },
    historyDir,
    publicDir,
  });
  writeFileSync(page, "PAGE");
  publishNight({
    night: "2026-10-16",
    lookup,
    input: {
      night: "2026-10-16",
      intents: [],
      house: { kta: 0, kore: 0 },
      balances: {},
      costToMine: [],
    },
    historyDir,
    publicDir,
  });
  assert.equal(readFileSync(page, "utf8"), "PAGE");
  assert.equal(JSON.parse(readFileSync(join(publicDir, "call-latest.json"), "utf8")).mode, "dry_run");
  assert.equal(JSON.parse(readFileSync(join(publicDir, "ladder.json"), "utf8")).mode, "dry_run");
  assert.equal(readdirSync(publicDir).some((name) => name.endsWith(".tmp")), false);
  assert.equal(readdirSync(join(publicDir, "calls")).some((name) => name.endsWith(".tmp")), false);
});

test("the same night is recorded once", () => {
  const dir = mkdtempSync(join(tmpdir(), "kore-once-"));
  const historyDir = join(dir, "history");
  const publicDir = join(dir, "public");
  const now = Date.parse("2026-10-17T00:05:00.000Z");
  const lookupPath = lookupFile(dir, { keeta_one: { fuel: "2.00000", streak: 4, paid: "1", waiting: "0" } }, 0, now);
  const before = readFileSync(lookupPath);
  const first = runNightly({ now, lookupPath, historyDir, publicDir, log() {} });
  const second = runNightly({ now, lookupPath, historyDir, publicDir, log() {} });
  assert.equal(first.skipped, false);
  assert.equal(first.night, "2026-10-16");
  assert.equal(first.seeded, true);
  assert.equal(first.appended, false);
  assert.equal(second.seeded, false);
  assert.equal(second.appended, false);
  assert.equal(existsSync(join(historyDir, "2026-10-16.json")), false);
  assert.equal(readFileSync(lookupPath).equals(before), true);

  const next = Date.parse("2026-10-18T00:05:00.000Z");
  lookupFile(dir, { keeta_one: { fuel: "2.00000", streak: 5, paid: "1", waiting: "0" } }, 0, next);
  const third = runNightly({ now: next, lookupPath, historyDir, publicDir, log() {} });
  const fourth = runNightly({ now: next, lookupPath, historyDir, publicDir, log() {} });
  assert.equal(third.appended, true);
  assert.equal(fourth.appended, false);
  const nights = readdirSync(historyDir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name));
  assert.deepEqual(nights, ["2026-10-17.json"]);
});

test("a lookup published before the close waits, and the later run records it once", () => {
  const now = Date.parse("2026-10-17T00:05:00.000Z");
  const close = Date.parse("2026-10-17T00:00:00.000Z");
  assert.equal(payoutLanded({ updated: "2026-10-16T23:59:59.000Z" }, close), false);
  assert.equal(payoutLanded({ updated: "2026-10-17T00:00:00.000Z" }, close), true);
  assert.equal(payoutLanded({}, close), false);

  const dir = mkdtempSync(join(tmpdir(), "kore-payout-"));
  const historyDir = join(dir, "history");
  const publicDir = join(dir, "public");
  const miners = { keeta_one: { fuel: "2.00000", streak: 4, paid: "1", waiting: "0" } };
  const lookupPath = lookupFile(dir, miners, 0, now, "2026-10-16T23:50:00.000Z");
  const lines = [];
  const early = runNightly({ now, lookupPath, historyDir, publicDir, log: (line) => lines.push(line) });
  assert.equal(early.skipped, true);
  assert.equal(early.night, "2026-10-16");
  assert.equal(lines[0], "Skip. Payout has not landed.");
  assert.equal(existsSync(join(historyDir, "seed.json")), false);
  assert.equal(existsSync(join(publicDir, "call-latest.json")), false);

  lookupFile(dir, miners, 0, now, "2026-10-17T00:04:00.000Z");
  const landed = runNightly({ now, lookupPath, historyDir, publicDir, log() {} });
  const again = runNightly({ now, lookupPath, historyDir, publicDir, log() {} });
  assert.equal(landed.skipped, false);
  assert.equal(landed.seeded, true);
  assert.equal(again.appended, false);
  assert.equal(existsSync(join(historyDir, "2026-10-16.json")), false);
});


test("the timer units stay off the runner and the missing lookup exits clean", () => {
  const service = readFileSync(join(ROOT, "systemd/koreminer-barter-dryrun.service"), "utf8");
  const timer = readFileSync(join(ROOT, "systemd/koreminer-barter-dryrun.timer"), "utf8");
  assert.match(service, /Type=oneshot/);
  assert.match(service, /bin\/sim\.mjs --nightly/);
  assert.equal(/Environment=/i.test(service), false);
  assert.equal(service.includes("/opt/koreminer/"), false);
  assert.equal(service.includes("/opt/keelend"), false);
  assert.match(timer, /OnCalendar=\*-\*-\* 00:05:00 UTC/);
  assert.match(timer, /OnCalendar=\*-\*-\* 01:05:00 UTC/);
  assert.match(timer, /Persistent=true/);
  assert.equal(/Environment=/i.test(timer), false);
  const run = spawnSync(process.execPath, [join(ROOT, "bin/sim.mjs"), "--nightly"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Skip\. Lookup is missing\./);
  assert.equal(existsSync(LOOKUP_PROBE), false);
});

const LOOKUP_PROBE = "/var/www/koreminer/lookup.json";
test("this workspace has no live lookup for the nightly probe", () => {
  assert.equal(existsSync(LOOKUP_PROBE), false);
  assert.equal(statSafe(LOOKUP_PROBE), null);
});

function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
