import { nightCounts } from "./eligibility.mjs";
import { HOUSE } from "./house.mjs";
import { truncateWallet } from "./publish.mjs";

export const RUNGS = [
  { name: "Practice Shield", at: 14 },
  { name: "Shift Boss Shield", at: 28 },
  { name: "Narrator Book", at: 56 },
  { name: "Barterer", at: 84 },
];

const EU = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE EU".split(" "),
);

const BANNED = /floor|yield|\bapr\b|dividend|passive income|guaranteed|more rewards coming|\bethereum\b|\bsolana\b|\bbase\b/i;

export function isEu(region) {
  return EU.has(String(region ?? "").trim().toUpperCase());
}

export function rankFor(streak) {
  const days = Number(streak) || 0;
  let rank = null;
  let next = RUNGS[0];
  for (let i = 0; i < RUNGS.length; i += 1) {
    if (days >= RUNGS[i].at) {
      rank = RUNGS[i].name;
      next = RUNGS[i + 1] ?? null;
    }
  }
  return { streak: days, rank, nextRank: next ? next.name : null, nextAt: next ? next.at : null };
}

export function countedDay(fuelNights) {
  return nightCounts(fuelNights);
}

export function daysFromFuel(fuelNights) {
  const nights = fuelNights ?? [];
  const flags = [];
  for (let i = 0; i < nights.length; i += 1) flags.push(countedDay(nights.slice(0, i + 1)));
  return flags;
}

export function applyShields(days) {
  let streak = 0;
  let weight = 0;
  const practice = { held: false, used: false };
  const shiftBoss = { held: false, used: false };
  for (const counted of days) {
    if (counted) {
      streak += 1;
      weight += 1;
    } else if (practice.held && !practice.used) {
      practice.used = true;
      weight += 0.5;
    } else if (shiftBoss.held && !shiftBoss.used) {
      shiftBoss.used = true;
      weight += 0.5;
    } else {
      streak = 0;
      weight = 0;
    }
    if (streak >= 14) practice.held = true;
    if (streak >= 28) shiftBoss.held = true;
  }
  return {
    ...rankFor(streak),
    weight,
    shields: { practice, shiftBoss },
    narrator: streak >= 56,
    barterer: streak >= 84,
  };
}

export function transferToken(record) {
  return { ok: false, record: { ...record, wallet: record.wallet, transferable: false } };
}

export function bartererStatus({ streak, region, revoked }) {
  if (isEu(region)) {
    return { offered: false, perks: [], fee: HOUSE.fee, message: "Not available in your region" };
  }
  if (revoked || (Number(streak) || 0) < 84) {
    return { offered: false, perks: [], fee: HOUSE.fee, message: "" };
  }
  return {
    offered: true,
    perks: ["badge", "early recap", "call-time vote"],
    fee: HOUSE.bartererFee,
    message: "Barterers trade cheaper at the call.",
    note: "Perks may change.",
  };
}

export function buyerNightCounts(fill) {
  if (!fill || fill.confirmed !== true || fill.side !== "buy") return false;
  return Number(fill.kta) >= 1;
}

export function noteBuyer(mining, fills) {
  let nights = 0;
  let streak = 0;
  for (const fill of fills ?? []) {
    if (buyerNightCounts(fill)) {
      nights += 1;
      streak += 1;
    } else {
      streak = 0;
    }
  }
  return { streak: mining.streak, weight: mining.weight, buyerNights: nights, buyerStreak: streak };
}

function fueled(row) {
  return Number(row?.fuel) > 0;
}

export function buyerBoard({ buyers, miners }) {
  const rows = Object.entries(buyers ?? [])
    .filter(([wallet]) => fueled(miners?.[wallet]))
    .map(([wallet, buyerNights]) => ({ wallet, buyerNights: Number(buyerNights) || 0 }))
    .sort((a, b) => b.buyerNights - a.buyerNights || (a.wallet < b.wallet ? -1 : 1))
    .slice(0, 10)
    .map((row, index) => ({ ...row, buyerRank: index + 1 }));
  return rows;
}

function rungCounts(rows) {
  const counts = {};
  for (const rung of RUNGS) counts[rung.name] = 0;
  for (const row of rows) if (row.rank) counts[row.rank] += 1;
  return counts;
}

export function buildPublicLadder({ miners, buys = [], revoked = [], regions = {} }) {
  const nights = {};
  for (const fill of buys) {
    if (!buyerNightCounts(fill)) continue;
    nights[fill.wallet] = (nights[fill.wallet] ?? 0) + 1;
  }
  const board = buyerBoard({ buyers: nights, miners });
  const place = new Map(board.map((row) => [row.wallet, row.buyerRank]));
  const wallets = Object.entries(miners ?? {}).map(([wallet, row]) => {
    const miningStreak = Number(row.streak) || 0;
    const mining = { streak: miningStreak, weight: miningStreak };
    const walked = applyShields(daysFromFuel(Array.from({ length: miningStreak }, () => Number(row.fuel))));
    const buyer = noteBuyer(mining, []);
    if (mining.streak !== miningStreak || buyer.streak !== miningStreak || buyer.weight !== miningStreak) {
      throw new Error("mining streak changed");
    }
    const status = bartererStatus({
      streak: walked.streak,
      region: regions[wallet],
      revoked: revoked.includes(wallet),
    });
    return {
      wallet: truncateWallet(wallet),
      streak: walked.streak,
      rank: walked.rank,
      nextRank: walked.nextRank,
      nextAt: walked.nextAt,
      shields: walked.shields,
      buyerNights: nights[wallet] ?? 0,
      buyerRank: place.get(wallet) ?? null,
      message: status.message,
    };
  });
  wallets.sort((a, b) => b.streak - a.streak || (a.wallet < b.wallet ? -1 : 1));
  const countable = wallets.map((row) =>
    row.message === "Not available in your region" && row.rank === "Barterer" ? { ...row, rank: null } : row,
  );
  const body = {
    mode: "dry_run",
    rungs: rungCounts(countable),
    wallets,
    buyers: board.map((row) => ({
      wallet: truncateWallet(row.wallet),
      buyerNights: row.buyerNights,
      buyerRank: row.buyerRank,
    })),
    copy: ["Barterers trade cheaper at the call.", "Perks may change."],
  };
  const text = JSON.stringify(body);
  if (BANNED.test(text)) throw new Error("public copy refused");
  if (/keeta_[a-z0-9]{20,}/.test(text)) throw new Error("public wallet refused");
  return body;
}
