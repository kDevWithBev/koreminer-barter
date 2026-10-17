// Claim rules. This file does not publish a block.
import { existsSync, readFileSync, renameSync } from "node:fs";

export const BRIDGE =
  "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
export const KNOWN_BASE = "0xfe6d5e3f8cff2dc8d2dea137c87f721c69343d7d";

const KNOWN_RAW = fromKta("23.348300571823728");

export function fromKta(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) return null;
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0").slice(0, 18));
}

export function isBaseAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && value.length === 42;
}

export function isKeetaAddress(value) {
  return typeof value === "string" && /^keeta_[a-z0-9]{40,80}$/.test(value);
}

export function claimMessage({ base, keeta, nonce, date }) {
  return `Koreminer claim\nBase: ${base}\nKeeta: ${keeta}\nNonce: ${nonce}\nDate: ${date}`;
}

export function checkClaim(body, now = Date.now()) {
  const base = String(body?.base ?? "");
  const keeta = String(body?.keeta ?? "");
  const nonce = String(body?.nonce ?? "");
  const date = String(body?.date ?? "");
  if (!isBaseAddress(base)) return { ok: false, reason: "bad-base" };
  if (base.toLowerCase() !== KNOWN_BASE) return { ok: false, reason: "no-credit" };
  if (!isKeetaAddress(keeta)) return { ok: false, reason: "bad-keeta" };
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(nonce)) return { ok: false, reason: "bad-nonce" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: "bad-date" };
  const signed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(signed) || Math.abs(now - signed) > 3 * 86_400_000) return { ok: false, reason: "stale" };
  return { ok: true, base: base.toLowerCase(), keeta, nonce, date, message: claimMessage({ base: base.toLowerCase(), keeta, nonce, date }) };
}

function moveMap(map, from, to) {
  if (!map.has(from)) return;
  const amount = map.get(from);
  map.delete(from);
  map.set(to, (map.get(to) ?? 0n) + amount);
}

export function reassign(share, to) {
  if (!isKeetaAddress(to) || to === BRIDGE) return "bad-keeta";
  const lots = share.lots.filter((lot) => lot.from === BRIDGE);
  if (lots.length === 0) return "none";
  if (lots.length !== 1) return "split";
  if (lots[0].remaining <= 0n || lots[0].remaining > KNOWN_RAW) return "extra";
  lots[0].from = to;
  moveMap(share.stake, BRIDGE, to);
  moveMap(share.pending, BRIDGE, to);
  moveMap(share.paid, BRIDGE, to);
  moveMap(share.depth, BRIDGE, to);
  for (const key of [...share.seen.keys()]) {
    if (key.endsWith(`:${BRIDGE}`)) {
      share.seen.delete(key);
      share.seen.set(`${key.slice(0, -(BRIDGE.length))}${to}`, true);
    }
  }
  if (share.streak.has(BRIDGE)) {
    if (!share.streak.has(to)) share.streak.set(to, share.streak.get(BRIDGE));
    share.streak.delete(BRIDGE);
  }
  return "moved";
}

export function applyClaimFile(books, dir) {
  const path = `${dir}/claims/approved.json`;
  if (!existsSync(path)) return false;
  const approved = JSON.parse(readFileSync(path, "utf8"));
  if (!approved || String(approved.base).toLowerCase() !== KNOWN_BASE) {
    renameSync(path, `${dir}/claims/waiting-${Date.now()}.json`);
    console.log("Claim waiting.", "base");
    return false;
  }
  const result = reassign(books.share, approved.keeta);
  if (result !== "moved") {
    renameSync(path, `${dir}/claims/waiting-${Date.now()}.json`);
    console.log("Claim waiting.", result);
    return false;
  }
  renameSync(path, `${dir}/claims/applied-${Date.now()}.json`);
  console.log("Claim moved to", approved.keeta);
  return true;
}
