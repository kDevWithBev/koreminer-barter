// Base address to Keeta address. This file does not publish a block.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { BRIDGE, isBaseAddress, isKeetaAddress } from "./claim.mjs";

export const SHAFT_BASE = "0xfe6d5e3f8cff2dc8d2dea137c87f721c69343d7d";
const BANNED_BASE = new Set([
  SHAFT_BASE,
  "0x1c24a0fb7bcf2154a9d37b7b3aa443bc63fcc698",
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789",
]);

export function linkMessage({ base, keeta, nonce, date }) {
  return `Link Base ${base} to Keeta ${keeta} for Koreminer, nonce ${nonce}, ${date}`;
}

export function checkLink(body, now = Date.now()) {
  const base = String(body?.base ?? "");
  const keeta = String(body?.keeta ?? "");
  const nonce = String(body?.nonce ?? "");
  const date = String(body?.date ?? "");
  if (!isBaseAddress(base)) return { ok: false, reason: "bad-base" };
  const lowered = base.toLowerCase();
  if (BANNED_BASE.has(lowered)) return { ok: false, reason: "bad-base" };
  if (!isKeetaAddress(keeta) || keeta === BRIDGE) return { ok: false, reason: "bad-keeta" };
  if (!/^[a-zA-Z0-9-]{16,64}$/.test(nonce)) return { ok: false, reason: "bad-nonce" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: "bad-date" };
  const signed = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(signed) || Math.abs(now - signed) > 3 * 86_400_000) return { ok: false, reason: "stale" };
  return {
    ok: true,
    base: lowered,
    keeta,
    nonce,
    date,
    message: linkMessage({ base: lowered, keeta, nonce, date }),
  };
}

export function commitLink(links, checked) {
  return {
    ...links,
    [checked.base]: { keeta: checked.keeta, nonce: checked.nonce, date: checked.date },
  };
}

export function readLinks(path) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function saveLinks(path, links) {
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(links));
  renameSync(tmp, path);
}

function moveMap(map, from, to) {
  if (!map?.has(from)) return;
  const amount = map.get(from);
  map.delete(from);
  map.set(to, (map.get(to) ?? 0n) + amount);
}

export function applyLinks(books, links) {
  const share = books?.share;
  if (!share) return false;
  let moved = false;
  for (const [base, row] of Object.entries(links ?? {})) {
    if (!isBaseAddress(base) || BANNED_BASE.has(base.toLowerCase())) continue;
    const from = `base:${base.toLowerCase()}`;
    const to = row?.keeta;
    if (!isKeetaAddress(to) || to === BRIDGE) continue;
    const has = share.stake.has(from)
      || share.pending.has(from)
      || share.paid.has(from)
      || share.depth.has(from)
      || share.lots.some((lot) => lot.from === from);
    if (!has) continue;
    for (const lot of share.lots) if (lot.from === from) lot.from = to;
    moveMap(share.stake, from, to);
    moveMap(share.pending, from, to);
    moveMap(share.paid, from, to);
    moveMap(share.depth, from, to);
    for (const key of [...share.seen.keys()]) {
      if (key.endsWith(`:${from}`)) {
        share.seen.delete(key);
        share.seen.set(`${key.slice(0, -from.length)}${to}`, true);
      }
    }
    if (share.streak.has(from)) {
      if (!share.streak.has(to)) share.streak.set(to, share.streak.get(from));
      share.streak.delete(from);
    }
    moved = true;
  }
  return moved;
}
