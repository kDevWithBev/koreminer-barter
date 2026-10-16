const BANNED = /floor|yield|\bapr\b|dividend|passive income|guaranteed|more rewards coming|\bethereum\b|\bsolana\b|\bbase\b/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const STORAGE_KEY = "koreminer.card.wallet";
export const WARMING = "Board is warming up, check back after the close";
export const UNKNOWN = "No shifts on record yet for this wallet.";
export const MALFORMED = "That is not a Keeta wallet address.";
export const NO_LADDER = "No ladder record yet.";
export const FOOTER = "Streaks and payouts are read from public data. Nothing here is financial advice.";

export function isKeetaAddress(value) {
  return typeof value === "string" && /^keeta_[a-z0-9]{40,80}$/.test(value);
}

export function normalizeWallet(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function shortWallet(wallet) {
  const text = String(wallet);
  if (text.length <= 14) return `${text.slice(0, 3)}…${text.slice(-2)}`;
  return `${text.slice(0, 10)}…${text.slice(-4)}`;
}

export function displayWallet(value) {
  const wallet = normalizeWallet(value);
  return isKeetaAddress(wallet) ? shortWallet(wallet) : "";
}

export function wholeCoins(value) {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.trunc(n);
}

export function withCommas(value) {
  return String(wholeCoins(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.trunc(nums.length / 2);
  if (nums.length % 2 === 1) return nums[mid];
  return (nums[mid - 1] + nums[mid]) / 2;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

export function etParts(instant) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const bag = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: bag.year,
    month: bag.month,
    day: bag.day,
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

export function nextClose(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(now);
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (date.getTime() <= start) return start;
  return start + DAY_MS;
}

export function closeLabel(ms) {
  const parts = etParts(new Date(ms));
  const suffix = parts.hour >= 12 ? "PM" : "AM";
  let hour = parts.hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${pad(parts.minute)} ${suffix} ET`;
}

export function updatedLabel(iso) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "Last updated —";
  const parts = etParts(new Date(ms));
  const suffix = parts.hour >= 12 ? "PM" : "AM";
  let hour = parts.hour % 12;
  if (hour === 0) hour = 12;
  const month = MONTHS[Number(parts.month) - 1];
  return `Last updated ${month} ${Number(parts.day)}, ${parts.year}, ${hour}:${pad(parts.minute)} ${suffix} ET`;
}

export function clockText(ms) {
  const total = !Number.isFinite(ms) || ms <= 0 ? 0 : Math.trunc(ms / 1000);
  const h = Math.trunc(total / 3600);
  const m = Math.trunc((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function refuse(text) {
  if (BANNED.test(text)) throw new Error("copy refused");
  if (/keeta_[a-z0-9]{20,}/.test(text)) throw new Error("full address refused");
  return text;
}

export function upgradesLine(miner) {
  if (!miner || !Object.prototype.hasOwnProperty.call(miner, "upgrades")) return "Upgrades: coming soon";
  if (!Array.isArray(miner.upgrades) || miner.upgrades.length === 0) return "No upgrades owned.";
  return `Upgrades: ${miner.upgrades.map((name) => String(name)).join(", ")}`;
}

export function shieldLine(shields) {
  const one = (name, row) => {
    if (row?.used) return `${name}: used`;
    if (row?.held) return `${name}: held`;
    return `${name}: not yet`;
  };
  return `${one("Practice Shield", shields?.practice)}. ${one("Shift Boss Shield", shields?.shiftBoss)}.`;
}

export function daysLine(days, nextRank) {
  if (!nextRank) return "";
  const left = Number(days) || 0;
  return `${left} ${left === 1 ? "day" : "days"} to ${nextRank}`;
}

function ladderFor(ladder, wallet) {
  const short = shortWallet(wallet);
  return (ladder?.wallets ?? []).find((row) => row.wallet === short) ?? null;
}

export function readPlayer({ wallet, lookup, ladder, lookupOk = true }) {
  const entered = normalizeWallet(wallet);
  if (!lookupOk) return { ok: false, kind: "lookup", text: WARMING, show: displayWallet(entered) };
  if (!isKeetaAddress(entered)) return { ok: false, kind: "malformed", text: MALFORMED, show: "" };
  const miner = lookup?.miners?.[entered];
  if (!miner) return { ok: false, kind: "unknown", text: UNKNOWN, show: shortWallet(entered) };
  const row = ladderFor(ladder, entered);
  const miningStreak = Number(miner.streak) || 0;
  const paid = wholeCoins(miner.paid);
  const waiting = wholeCoins(miner.waiting);
  const ladderStreak = row ? Number(row.ladderStreak ?? row.streak) || 0 : null;
  const nextRank = row?.nextRank ?? null;
  const nextAt = row?.nextAt ?? null;
  const daysToNext = row && nextAt != null ? Math.max(0, Number(nextAt) - ladderStreak) : null;
  let progress = 0;
  if (row && nextAt == null) progress = 1;
  else if (row && Number(nextAt) > 0) progress = Math.min(1, Math.max(0, ladderStreak / Number(nextAt)));
  const used = row ? Number(row.shieldsUsed) || 0 : null;
  const usedText = used == null ? "" : used === 1 ? "1 shield used" : `${used} shields used`;
  const view = {
    ok: true,
    kind: row ? "known" : "no-ladder",
    show: shortWallet(entered),
    fuel: String(miner.fuel ?? "0"),
    miningStreak,
    ladderStreak,
    shieldsUsed: used,
    rank: row?.rank ?? null,
    nextRank,
    nextAt,
    daysToNext,
    progress,
    buyerNights: row ? Number(row.buyerNights) || 0 : null,
    upgrades: upgradesLine(miner),
    lines: {
      fuel: `Fuel ${String(miner.fuel ?? "0")} KTA`,
      mining: `Mining streak ${miningStreak}`,
      ladder: row ? `Ladder streak ${ladderStreak} (${usedText})` : NO_LADDER,
      rank: row ? `Rank ${row.rank || "No rank yet"}` : "Rank: no ladder record yet.",
      next: row ? daysLine(daysToNext, nextRank) : "",
      shields: row ? shieldLine(row.shields) : "Shields: no ladder record yet.",
      buyers: row ? `Buyer nights ${Number(row.buyerNights) || 0}` : "Buyer nights: no ladder record yet.",
      barterer: row ? (row.message || (row.rank === "Barterer" ? "Barterers trade cheaper at the call." : "Not a Barterer yet.")) : NO_LADDER,
      paid: `${withCommas(paid)} KORE paid`,
      waiting: `${withCommas(waiting)} KORE waiting`,
      upgrades: upgradesLine(miner),
    },
  };
  view.text = refuse(Object.values(view.lines).filter(Boolean).join("\n"));
  return view;
}

export function leaderboard(lookup, limit = 25) {
  const source = Object.entries(lookup?.miners ?? {}).map(([wallet, row]) => ({
    full: wallet,
    wallet: shortWallet(wallet),
    streak: Number(row?.streak) || 0,
    paid: wholeCoins(row?.paid),
  }));
  source.sort((a, b) => b.streak - a.streak || b.paid - a.paid || (a.wallet < b.wallet ? -1 : 1));
  const rows = source.slice(0, limit).map((row, index) => ({
    place: index + 1,
    wallet: row.wallet,
    streak: row.streak,
    paid: row.paid,
    line: `${index + 1}. ${row.wallet} · streak ${row.streak} · ${withCommas(row.paid)} KORE`,
  }));
  refuse(rows.map((row) => row.line).join("\n"));
  for (const row of source) {
    if (rows.some((item) => item.line.includes(row.full))) throw new Error("full address refused");
  }
  return rows;
}

export function summary(lookup) {
  const miners = Object.values(lookup?.miners ?? {});
  const streaks = miners.map((row) => Number(row?.streak) || 0);
  const paid = miners.reduce((sum, row) => sum + wholeCoins(row?.paid), 0);
  const longest = streaks.length ? Math.max(...streaks) : 0;
  const mid = median(streaks);
  const line = `${miners.length} miners · longest streak ${longest} · median streak ${mid == null ? "—" : String(mid)} · ${withCommas(paid)} KORE paid`;
  return { miners: miners.length, longest, median: mid, paid, line: refuse(line) };
}

export function rungLines(ladder) {
  return Object.entries(ladder?.rungs ?? {}).map(([name, count]) => `${name} ${count}`);
}

export function publicText({ lookup, ladder, wallet, lookupOk = true }) {
  const player = wallet ? readPlayer({ wallet, lookup, ladder, lookupOk }) : null;
  const text = [
    player?.text ?? "",
    lookupOk ? summary(lookup).line : "",
    ...(lookupOk ? leaderboard(lookup).map((row) => row.line) : []),
    ...(lookupOk ? rungLines(ladder) : []),
    lookupOk ? updatedLabel(lookup?.updated) : WARMING,
    FOOTER,
  ].filter(Boolean).join("\n");
  return refuse(text);
}
