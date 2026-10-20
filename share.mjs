// Running share. Nothing here sends a transaction.
// KORE accrues while KTA is in the earning queue.
// Your share is your unburned KTA divided by all unburned KTA.
// The 2 KTA reserve does not earn. An empty queue earns nothing.

import { DAY_MS, dayBudget, dayKey, dayStart } from "./ledger.mjs";

export const UNIT = 1_000_000_000_000n;
export const RESERVE = 2n * 10n ** 18n;

export function createShare(nowMs) {
  return {
    lastMs: nowMs,
    reserve: 0n,
    lots: [],
    stake: new Map(),
    pending: new Map(),
    paid: new Map(),
    depth: new Map(),
    seen: new Map(),
    streak: new Map(),
  };
}

function totalStake(state) {
  let sum = 0n;
  for (const amount of state.stake.values()) sum += amount;
  return sum;
}

function rowsOf(map) {
  return [...map.entries()]
    .filter(([, amount]) => amount > 0n)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function add(map, key, amount) {
  map.set(key, (map.get(key) ?? 0n) + amount);
}

function mark(state, day) {
  if (dayBudget(Date.parse(`${day}T00:00:00Z`)) <= 0n) return;
  for (const [from, amount] of state.stake) {
    if (amount > 0n) state.seen.set(`${day}:${from}`, true);
  }
}

function closeDays(state, fromMs, toMs) {
  let day = dayStart(fromMs);
  const end = dayStart(toMs) - DAY_MS;
  while (day <= end) {
    const key = dayKey(day);
    if (dayBudget(day + 3_600_000) > 0n) {
      const prev = dayKey(day - DAY_MS);
      const known = new Set([...state.streak.keys(), ...state.depth.keys()]);
      for (const seenKey of state.seen.keys()) {
        if (seenKey.startsWith(`${key}:`)) known.add(seenKey.slice(key.length + 1));
      }
      for (const from of known) {
        const row = state.streak.get(from) ?? { count: 0, last: "" };
        if (state.seen.get(`${key}:${from}`)) {
          row.count = row.last === prev ? row.count + 1 : 1;
          row.last = key;
        } else if (row.count > 0) {
          row.count = 0;
        }
        state.streak.set(from, row);
      }
    }
    for (const seenKey of [...state.seen.keys()]) {
      if (seenKey.startsWith(`${key}:`)) state.seen.delete(seenKey);
    }
    day += DAY_MS;
  }
}

export function accrue(state, toMs) {
  if (toMs < state.lastMs) throw new Error("time moved backwards");
  let t = state.lastMs;
  while (t < toMs) {
    const sliceEnd = Math.min(toMs, dayStart(t) + DAY_MS);
    const ms = BigInt(sliceEnd - t);
    const budget = dayBudget(t);
    const stake = totalStake(state);
    mark(state, dayKey(t));
    if (budget > 0n && stake > 0n && ms > 0n) {
      const pot = (budget * UNIT * ms) / BigInt(DAY_MS);
      const rows = rowsOf(state.stake);
      let given = 0n;
      rows.forEach(([from, amount], index) => {
        const share = index === rows.length - 1 ? pot - given : (pot * amount) / stake;
        given += share;
        add(state.pending, from, share);
      });
    }
    t = sliceEnd;
  }
  if (toMs > state.lastMs && dayStart(toMs) > dayStart(state.lastMs)) {
    closeDays(state, state.lastMs, toMs);
  }
  state.lastMs = toMs;
}

export function deposit(state, from, amount, nowMs) {
  if (amount <= 0n) return 0n;
  accrue(state, nowMs);
  let rest = amount;
  if (state.reserve < RESERVE) {
    const room = RESERVE - state.reserve;
    const fill = rest < room ? rest : room;
    state.reserve += fill;
    rest -= fill;
  }
  if (rest > 0n) {
    state.lots.push({ from, remaining: rest });
    add(state.stake, from, rest);
    mark(state, dayKey(nowMs));
  }
  return rest;
}

export function burn(state, fee, nowMs) {
  accrue(state, nowMs);
  let left = fee;
  while (left > 0n && state.lots.length > 0) {
    const lot = state.lots[0];
    const take = lot.remaining < left ? lot.remaining : left;
    lot.remaining -= take;
    add(state.stake, lot.from, -take);
    add(state.depth, lot.from, take);
    left -= take;
    if (lot.remaining === 0n) state.lots.shift();
  }
  return left;
}

export function whole(units) {
  return units / UNIT;
}

export function lookup(state, from) {
  const counted = state.pending.get(from) ?? 0n;
  const paid = state.paid.get(from) ?? 0n;
  const waiting = counted - paid * UNIT;
  return {
    fuel: state.stake.get(from) ?? 0n,
    shareOf: totalStake(state),
    depth: state.depth.get(from) ?? 0n,
    streak: state.streak.get(from)?.count ?? 0,
    counted,
    waiting: waiting > 0n ? waiting : 0n,
    paid,
  };
}

export function due(state, from) {
  const counted = whole(state.pending.get(from) ?? 0n);
  const paid = state.paid.get(from) ?? 0n;
  return counted > paid ? counted - paid : 0n;
}

export function addPaid(state, from, amount) {
  if (amount <= 0n || amount > due(state, from)) throw new Error("payout does not match what is due");
  add(state.paid, from, amount);
}

export function markPaid(state, from, amount) {
  if (amount <= 0n || amount !== due(state, from)) throw new Error("payout does not match what is due");
  add(state.paid, from, amount);
}
