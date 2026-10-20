// Payout decisions. Nothing here publishes a block.
import { addPaid, due, whole } from "./share.mjs";

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
  return "hold";
}

export function applyPaid(share, intent) {
  const from = typeof intent?.from === "string" ? intent.from : "";
  const key = typeof intent?.key === "string" ? intent.key : "";
  const prefix = `kore-${from}-`;
  if (!from || !key.startsWith(prefix)) return "halt";
  const rest = key.slice(prefix.length);
  if (!/^[0-9]+$/.test(rest)) return "halt";
  let amount = 0n;
  try { amount = BigInt(intent.amount); } catch { return "halt"; }
  const count = BigInt(rest);
  const paid = share.paid.get(from) ?? 0n;
  const owed = due(share, from);
  if (paid >= count) return "done";
  if (count - paid !== amount) return "halt";
  if (owed < amount) return "halt";
  addPaid(share, from, amount);
  return "marked";
}
