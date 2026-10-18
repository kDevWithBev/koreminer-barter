export const DAY_MS = 86_400_000;
export const startMs = Date.parse("2026-10-10T00:00:00Z");
const eraAmounts = [11_200_000n, 5_600_000n, 2_800_000n, 1_400_000n];
const eraStart = [0, 1, 2, 3].map((year) => Date.UTC(2026 + year, 9, 10));

export function dayStart(nowMs) {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayBudget(nowMs) {
  const start = dayStart(nowMs);
  if (start < startMs) return 0n;
  for (let era = 0; era < eraAmounts.length; era += 1) {
    const from = eraStart[era];
    const to = eraStart[era + 1] ?? Date.UTC(2030, 9, 10);
    if (start < from || start >= to) continue;
    const days = (to - from) / DAY_MS;
    const amount = eraAmounts[era];
    const basePay = amount / BigInt(days);
    const extra = amount % BigInt(days);
    const dayIndex = (start - from) / DAY_MS;
    return basePay + (dayIndex === days - 1 ? extra : 0n);
  }
  return 0n;
}

export function splitDay(budget, miners) {
  const rows = [...miners.entries()].filter(([, amount]) => amount > 0n);
  if (budget <= 0n || rows.length === 0) return [];
  rows.sort((a, b) => {
    if (a[1] === b[1]) return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    return a[1] > b[1] ? -1 : 1;
  });
  const total = rows.reduce((sum, [, amount]) => sum + amount, 0n);
  let allocated = 0n;
  return rows.map(([from, amount], index) => {
    const share = index === rows.length - 1 ? budget - allocated : (budget * amount) / total;
    allocated += share;
    return { from, amount, share };
  });
}

export function addDeposit(miners, from, amount, { intake, sink }) {
  if (amount <= 0n) return false;
  if (from === intake || from === sink) return false;
  miners.set(from, (miners.get(from) ?? 0n) + amount);
  return true;
}
