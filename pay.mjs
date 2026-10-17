// Payout decisions. Nothing here publishes a block.
import { due, markPaid, whole } from "./share.mjs";

export function choosePayout(share, { intake, sink, skip = [] }) {
  const done = new Set(skip);
  let best = null;
  for (const from of share.pending.keys()) {
    if (from === intake || from === sink || done.has(from)) continue;
    if (from === "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle") continue;
    if (!String(from).startsWith("keeta_")) continue;
    const amount = due(share, from);
    if (amount <= 0n) continue;
    const counted = whole(share.pending.get(from) ?? 0n);
    const row = { from, amount, key: `kore-${from}-${counted}` };
    if (!best || row.amount > best.amount || (row.amount === best.amount && row.from < best.from)) best = row;
  }
  return best;
}

export function feeFits(balance, fee, reserve) {
  return fee > 0n && balance >= fee + reserve;
}

export function floorAfter(balance, amount) {
  if (amount <= 0n || amount > balance) return null;
  return balance - amount;
}

export function judgeIntent(balance, intent) {
  const floor = BigInt(intent.floor);
  const amount = BigInt(intent.amount);
  if (balance === floor) return "paid";
  if (balance === floor + amount) return "missed";
  return "halt";
}

export function applyPaid(share, intent) {
  const amount = BigInt(intent.amount);
  const owed = due(share, intent.from);
  if (owed === 0n) return "done";
  if (owed !== amount) return "halt";
  markPaid(share, intent.from, amount);
  return "marked";
}
