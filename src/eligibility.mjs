import { median, r8 } from "./money.mjs";

const NIGHT_KTA = 0.02;

export function nightCounts(fuelNights) {
  const nights = (fuelNights ?? []).slice(-7);
  if (!nights.length) return false;
  const avg = nights.reduce((sum, value) => sum + value, 0) / nights.length;
  return avg >= NIGHT_KTA;
}

export function eligibility(input) {
  const minedRows = Object.entries(input.mined ?? {});
  const koreValues = minedRows.map(([, row]) => row.kore ?? 0);
  const cap = median(koreValues);
  const weights = {};
  const counted = {};
  for (const [wallet, row] of minedRows) {
    const countedDays = nightCounts(input.fuelNights?.[wallet]);
    counted[wallet] = countedDays;
    const streak = row.streak ?? 0;
    const shield = row.shieldDays ?? 0;
    const effective = streak + shield * 0.5;
    const kore = cap == null ? row.kore ?? 0 : Math.min(row.kore ?? 0, cap);
    weights[wallet] = r8(effective * kore);
  }
  return { weights, counted, koreCap: cap };
}
