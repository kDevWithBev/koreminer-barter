import { writeAtomic } from "./atomic.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const NIGHT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export function assertOutsideRunner(dir) {
  if (typeof dir !== "string" || dir.trim() === "") throw new Error("history path refused");
  const resolved = resolve(dir);
  if (resolved === "/opt/koreminer" || resolved.startsWith("/opt/koreminer/")) {
    throw new Error("history path refused");
  }
  const base = resolved.slice(resolved.lastIndexOf("/") + 1);
  const phrase = ["seed", "txt"].join(".");
  if (base === "books.json" || base === "lookup.json" || base === phrase) {
    throw new Error("history path refused");
  }
  return resolved;
}

function writeJson(dir, name, body) {
  writeAtomic(dir, name, `${JSON.stringify(body, null, 2)}\n`);
}

export function snapshotWallets(lookup) {
  const wallets = {};
  for (const [wallet, row] of Object.entries(lookup?.miners ?? {})) {
    if (!wallet) continue;
    const fuel = typeof row?.fuel === "string" || typeof row?.fuel === "number" ? row.fuel : "0";
    wallets[wallet] = { fuel, streak: Number(row?.streak) || 0 };
  }
  return wallets;
}

export function ensureHistory({ dir, night, lookup }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(night))) throw new Error("bad night");
  const resolved = assertOutsideRunner(dir);
  mkdirSync(resolved, { recursive: true });
  const seedPath = join(resolved, "seed.json");
  const nightName = `${night}.json`;
  if (!existsSync(seedPath)) {
    const names = readdirSync(resolved);
    if (names.some((name) => NIGHT_FILE.test(name))) throw new Error("history seed missing");
    writeJson(resolved, "seed.json", { night, kind: "seed", wallets: snapshotWallets(lookup) });
    return { seeded: true, appended: false };
  }
  if (existsSync(join(resolved, nightName))) return { seeded: false, appended: false };
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  if (seed.night === night) return { seeded: false, appended: false };
  writeJson(resolved, nightName, { night, kind: "night", wallets: snapshotWallets(lookup) });
  return { seeded: false, appended: true };
}

export function loadWalletHistory(dir) {
  const resolved = assertOutsideRunner(dir);
  const seedPath = join(resolved, "seed.json");
  if (!existsSync(seedPath)) return {};
  const seed = JSON.parse(readFileSync(seedPath, "utf8"));
  const wallets = {};
  for (const [wallet, row] of Object.entries(seed.wallets ?? {})) {
    wallets[wallet] = { seedStreak: Number(row.streak) || 0, nights: [] };
  }
  const files = readdirSync(resolved).filter((name) => NIGHT_FILE.test(name)).sort();
  for (const name of files) {
    const night = JSON.parse(readFileSync(join(resolved, name), "utf8"));
    const present = new Set(Object.keys(night.wallets ?? {}));
    for (const wallet of Object.keys(wallets)) {
      if (!present.has(wallet)) wallets[wallet].nights.push({ night: night.night, fuel: "0", streak: 0 });
    }
    for (const [wallet, row] of Object.entries(night.wallets ?? {})) {
      if (!wallets[wallet]) {
        wallets[wallet] = { seedStreak: Number(row.streak) || 0, nights: [] };
        continue;
      }
      wallets[wallet].nights.push({
        night: night.night,
        fuel: row.fuel ?? "0",
        streak: Number(row.streak) || 0,
      });
    }
  }
  return wallets;
}
