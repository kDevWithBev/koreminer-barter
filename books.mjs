// Shaft books. Deposits, burns, and the nightly plan.
// This file never publishes a block.

import { RESERVE, accrue, burn, createShare, deposit, due, lookup, whole } from "./share.mjs";
import { startMs } from "./ledger.mjs";

const recentCap = 5_000;
const burnWaitMs = 120_000;
const dust = 120_000_000_000_000n; // one pick. Smaller than this is not a miner's send.

export function stakeOf(books) {
  let sum = 0n;
  for (const amount of books.share.stake.values()) sum += amount;
  return sum;
}

export function accounted(books) {
  return books.share.reserve + stakeOf(books) + books.operator;
}

export function createBooks(nowMs, balance) {
  const share = createShare(nowMs);
  let operator = balance;
  if (operator >= RESERVE) {
    share.reserve = RESERVE;
    operator -= RESERVE;
  } else {
    share.reserve = operator;
    operator = 0n;
  }
  return {
    share,
    operator,
    cursor: "",
    recent: [],
    pendingDrops: [],
    pendingSince: 0,
    arm: startMs,
  };
}

function applyBurn(books, fee, nowMs) {
  const cover = stakeOf(books) + books.operator;
  if (fee < 0n || fee > cover) return false;
  const left = burn(books.share, fee, nowMs);
  if (left > books.operator) return false;
  books.operator -= left;
  return true;
}

export function notePublished(books, drop, nowMs) {
  if (drop <= 0n) return;
  if (books.pendingDrops.length === 0) books.pendingSince = nowMs;
  books.pendingDrops.push(drop);
}

export function ingest(books, staple) {
  if (!staple?.blocksHash || books.recent.includes(staple.blocksHash)) return "seen";
  const when = !Number.isFinite(staple.timeMs) || staple.timeMs < books.share.lastMs
    ? books.share.lastMs
    : staple.timeMs;
  let reserve = books.share.reserve;
  let stake = stakeOf(books);
  let operator = books.operator;
  for (const item of staple.deposits ?? []) {
    if (item.amount <= 0n) continue;
    if (staple.timeMs < books.arm) {
      operator += item.amount;
      continue;
    }
    if (reserve < RESERVE) {
      const room = RESERVE - reserve;
      const fill = item.amount < room ? item.amount : room;
      reserve += fill;
      stake += item.amount - fill;
    } else {
      stake += item.amount;
    }
  }
  const drops = books.pendingDrops.slice(0, staple.ownPicks ?? 0);
  const burnSum = drops.reduce((sum, drop) => sum + drop, 0n);
  if (burnSum > stake + operator) return "halt-reserve";
  for (const item of staple.deposits ?? []) {
    if (item.amount <= 0n) continue;
    if (staple.timeMs < books.arm) {
      books.operator += item.amount;
      continue;
    }
    deposit(books.share, item.from, item.amount, when);
  }
  for (const drop of drops) {
    books.pendingDrops.shift();
    if (!applyBurn(books, drop, when)) return "halt-reserve";
  }
  if (books.pendingDrops.length === 0) books.pendingSince = 0;
  if (when > books.share.lastMs) accrue(books.share, when);
  books.recent.push(staple.blocksHash);
  if (books.recent.length > recentCap) books.recent.splice(0, books.recent.length - recentCap);
  return "ok";
}

export function reconcile(books, balance, chainMs, nowMs) {
  if (chainMs > books.share.lastMs) accrue(books.share, chainMs);
  let expected = accounted(books);
  if (balance > expected && balance - expected < dust) {
    books.operator += balance - expected;
    expected = accounted(books);
  }
  if (balance === expected && books.pendingDrops.length === 0) return "ok";
  if (balance > expected) return "missing-deposit";
  const short = expected - balance;
  const pending = books.pendingDrops.reduce((sum, drop) => sum + drop, 0n);
  if (books.pendingDrops.length > 0) {
    const waited = books.pendingSince > 0 && nowMs - books.pendingSince >= burnWaitMs;
    if (!(waited && pending === short)) return "waiting-burn";
  }
  if (short > stakeOf(books) + books.operator) return "halt-reserve";
  if (!applyBurn(books, short, chainMs)) return "halt-reserve";
  books.pendingDrops = [];
  books.pendingSince = 0;
  return accounted(books) === balance ? "ok" : "mismatch";
}

export function payoutPlan(books, sending = false) {
  const rows = [];
  for (const from of books.share.pending.keys()) {
    const amount = due(books.share, from);
    if (amount <= 0n) continue;
    const counted = whole(books.share.pending.get(from) ?? 0n);
    rows.push({
      from,
      amount: amount.toString(),
      key: `kore:${from}:${counted}`,
    });
  }
  rows.sort((a, b) => (a.amount === b.amount ? (a.from < b.from ? -1 : 1) : (BigInt(a.amount) > BigInt(b.amount) ? -1 : 1)));
  return { send: sending === true, rows };
}

function kta(raw) {
  const whole = raw / 10n ** 18n;
  const frac = (raw < 0n ? -raw : raw) % 10n ** 18n;
  return `${whole}.${frac.toString().padStart(18, "0").slice(0, 5)}`;
}

function ratio(part, all) {
  const scaled = (part * 10_000n) / all;
  return `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, "0")}`;
}

function koreUnits(raw) {
  const wholePart = raw / 1_000_000_000_000n;
  const frac = (raw < 0n ? -raw : raw) % 1_000_000_000_000n;
  return `${wholePart}.${frac.toString().padStart(12, "0").slice(0, 6)}`;
}

export function publicBooks(books, sending = false) {
  const all = stakeOf(books);
  const names = new Set([
    ...books.share.stake.keys(),
    ...books.share.pending.keys(),
    ...books.share.depth.keys(),
    ...books.share.paid.keys(),
  ]);
  const ranked = [];
  for (const from of names) {
    const row = lookup(books.share, from);
    if (row.fuel === 0n && row.counted === 0n && row.depth === 0n && row.paid === 0n) continue;
    ranked.push({ from, row });
  }
  ranked.sort((a, b) => {
    if (a.row.counted === b.row.counted) return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
    return a.row.counted > b.row.counted ? -1 : 1;
  });
  const bridge =
    "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
  const knownBase = "0xfe6d5e3f8cff2dc8d2dea137c87f721c69343d7d";
  const held = [];
  const miners = {};
  for (const { from, row } of ranked) {
    if (from === bridge) {
      held.push({
        base: knownBase,
        fuel: kta(row.fuel),
        waiting: whole(row.waiting).toString(),
        note: "Base bridge deposit. Claim at /claim. Not a Keeta miner.",
      });
      continue;
    }
    const share = all === 0n || row.fuel === 0n ? "0.0000" : ratio(row.fuel, all);
    miners[from] = {
      fuel: kta(row.fuel),
      share,
      depth: kta(row.depth),
      streak: row.streak,
      counted: koreUnits(row.counted),
      waiting: whole(row.waiting).toString(),
      paid: row.paid.toString(),
    };
  }
  const board = ranked.filter(({ from }) => from !== bridge).slice(0, 20).map(({ from, row }) => ({
    from,
    counted: koreUnits(row.counted),
  }));
  return {
    updated: new Date(books.share.lastMs).toISOString(),
    send: sending === true,
    fuel: kta(all),
    miners,
    held,
    board,
  };
}

function mapToObject(map) {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, value.toString()]));
}

export function booksToJson(books) {
  return {
    lastMs: books.share.lastMs,
    reserve: books.share.reserve.toString(),
    operator: books.operator.toString(),
    cursor: books.cursor,
    recent: books.recent,
    pendingDrops: books.pendingDrops.map((drop) => drop.toString()),
    pendingSince: books.pendingSince,
    arm: books.arm,
    lots: books.share.lots.map((lot) => ({ from: lot.from, remaining: lot.remaining.toString() })),
    stake: mapToObject(books.share.stake),
    pending: mapToObject(books.share.pending),
    paid: mapToObject(books.share.paid),
    depth: mapToObject(books.share.depth),
    seen: [...books.share.seen.keys()],
    streak: Object.fromEntries([...books.share.streak.entries()].map(([key, row]) => [key, row])),
  };
}

function objectToMap(object, big = true) {
  const map = new Map();
  for (const [key, value] of Object.entries(object ?? {})) map.set(key, big ? BigInt(value) : value);
  return map;
}

export function booksFromJson(raw) {
  const share = createShare(Number(raw.lastMs) || 0);
  share.reserve = BigInt(raw.reserve ?? "0");
  share.lastMs = Number(raw.lastMs) || 0;
  share.lots = (raw.lots ?? []).map((lot) => ({ from: lot.from, remaining: BigInt(lot.remaining) }));
  share.stake = objectToMap(raw.stake);
  share.pending = objectToMap(raw.pending);
  share.paid = objectToMap(raw.paid);
  share.depth = objectToMap(raw.depth);
  share.seen = new Map((raw.seen ?? []).map((key) => [key, true]));
  share.streak = new Map(Object.entries(raw.streak ?? {}));
  return {
    share,
    operator: BigInt(raw.operator ?? "0"),
    cursor: raw.cursor ?? "",
    recent: raw.recent ?? [],
    pendingDrops: (raw.pendingDrops ?? []).map((drop) => BigInt(drop)),
    pendingSince: Number(raw.pendingSince) || 0,
    arm: Number(raw.arm) || startMs,
  };
}
