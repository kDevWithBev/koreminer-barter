// Streak ladder for the pit. Cosmetic only: nothing here touches KORE, KTA or fees.
// A day counts when the wallet has at least one counted send (>= 1 KTA to the fire address) that UTC day.
// Rungs 14 / 28 / 56 / 84. Rank keeps the highest rung reached. Each held shield covers one missed day on its own.
// Port of sim v5.1 ladder_* (2026-10-26-sim-v5.1.py). Keep field names: pit-check.mjs compares state with the sim.

export const RUNGS = [[14, "Practice Shield"], [28, "Shift Boss Shield"], [56, "Narrator Book"], [84, "Barterer"]];

export function rungIdx(streak) {
  let i = -1;
  RUNGS.forEach(([n], k) => { if (streak >= n) i = k; });
  return i;
}

export function rungName(best) {
  return best >= 0 ? RUNGS[best][1] : "";
}

export function newLw(streak = 0, best = -1, shields = 0, practiceGiven = false) {
  return { streak, best, shields, used_run: 0, used_total: 0, practice_given: practiceGiven, shift_boss_grants: 0, perks: [], missed_total: 0, frozen: false };
}

// Seed from the Oct 25 close snapshot (md5 47a2d78b...). Bob, Oct 26: every non-frozen wallet at streak >= 14 gets one
// Practice Shield; frozen wallets (aabz6zxb) keep the snapshot record exactly and never change.
export function seedLadder(snapshot, { frozen = new Set(), seedPractice = true } = {}) {
  const out = {};
  for (const w of Object.keys(snapshot.wallets).sort()) {
    const v = snapshot.wallets[w];
    const sh = v.ladder.shields;
    const held = (sh.practice.held ? 1 : 0) + (sh.shiftBoss.held ? 1 : 0);
    const best = rungIdx(v.mining_streak);
    const snapRank = v.rank_rung_from_streak ?? null;
    if ((best >= 0 ? RUNGS[best][1] : null) !== snapRank) throw new Error(`snapshot rank mismatch ${w}`);
    const lw = newLw(v.mining_streak, best, held, Boolean(sh.practice.held || sh.practice.used));
    lw.used_total = v.ladder.shieldsUsed;
    if (frozen.has(w)) lw.frozen = true;
    else if (seedPractice && lw.streak >= 14 && !lw.practice_given) {
      lw.shields += 1; lw.practice_given = true; lw.seeded_practice = true;
    }
    out[w] = lw;
  }
  return out;
}

function hit(lw, w, day, ev) {
  lw.streak += 1;
  const s = lw.streak;
  if (s === 14 && !lw.practice_given) { lw.shields += 1; lw.practice_given = true; ev.push([day, w, "grant_practice_shield", s]); }
  if (s === 28) {
    lw.shields += 1; lw.shift_boss_grants += 1; ev.push([day, w, "grant_shift_boss_shield", s]);
    if (!lw.perks.includes("ledger_page")) lw.perks.push("ledger_page");
  }
  if (s === 56 && !lw.perks.includes("narrator_book")) lw.perks.push("narrator_book");
  if (s === 84 && !lw.perks.includes("barterer_badge")) lw.perks.push("barterer_badge");
  const b = rungIdx(s);
  if (b > lw.best) { lw.best = b; ev.push([day, w, `rank_up:${RUNGS[b][1]}`, s]); }
}

function miss(lw, w, day, ev) {
  lw.missed_total += 1;
  if (lw.streak === 0) return;
  if (lw.shields > 0) {
    lw.shields -= 1; lw.used_run += 1; lw.used_total += 1; ev.push([day, w, "shield_used", lw.streak]);
  } else {
    ev.push([day, w, "streak_reset", lw.streak]); lw.streak = 0; lw.used_run = 0;
  }
}

function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// counted: Set of wallets with >= 1 counted send today. A gap means a skipped close: that must halt and backfill first.
export function ladderStep(ladder, meta, day, counted, ev) {
  const last = meta.last;
  if (!(last === null || last === undefined || nextDay(last) === day)) throw new Error(`ladder gap ${last} -> ${day}: a skipped close must halt and backfill`);
  const all = [...new Set([...Object.keys(ladder), ...counted])].sort();
  for (const w of all) {
    if (!ladder[w]) ladder[w] = newLw();
    const lw = ladder[w];
    if (lw.frozen) continue;
    (counted.has(w) ? hit : miss)(lw, w, day, ev);
  }
  meta.last = day;
}
