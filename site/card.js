// Full ban list from the copy v1 self-check (§6), plus the older terms. "returned" (required: "can't be returned") and
// "recap" stay legal: the list bans "returns" and has no bare "cap".
const BANNED = /price|returns|\$|floor|yield|\bapr\b|dividend|passive income|guaranteed|backed by|reward|deflationary|jackpot|prize|\btps\b|\bbuy|\brates?\b|sealed|21M|supply|proof of burn|every miner|earn|decimal|@keeta|trey|wednesday|thursday|\bwed\b|\bthu\b|\bpicks?\b|fewer|bigger|more rewards coming|\bethereum\b|\bsolana\b|\bbase\b/i;
export const FIRE = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const STORAGE_KEY = "koreminer.card.wallet";
export const WARMING = "Board is warming up, check back after the close";
export const UNKNOWN = "No counted sends yet for this wallet. Send more than 1 KTA to start a streak.";
export const MALFORMED = "That is not a Keeta wallet address.";
export const NO_LADDER = "No ladder record yet.";
export const FOOTER = "Streaks and payouts are read from public data. Nothing here is financial advice.";
export const WHOLE_NOTE = "KORE is counted in whole coins. If a wallet app shows a tiny number, the explorer shows the real count.";
export const SEND_LEAD = "Send more than 1 KTA from your own wallet to the fire address:";
export const SEND_TIP = "Sends from the same wallet in one mine day add up.";
export const SEND_NOTE = "Sends of 1 KTA or less are not counted and can't be returned. KORE, other tokens and sends to any other address aren't counted or returned either.";
export const SHOP_EMPTY = "None yet. The shop comes later.";

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

const RUNG_DAYS = { "Practice Shield": 14, "Shift Boss Shield": 28, "Shift Boss": 28, "Narrator Book": 56, Narrator: 56, Barterer: 84 };

// Rank keeps the highest rung reached (Decision 8): best is the ladder rank name (or days); the streak can be lower after a reset.
export function rankStory(streak, best = null) {
  const now = Number(streak) || 0;
  const bestDays = typeof best === "number" ? best : RUNG_DAYS[best] ?? 0;
  const days = Math.max(now, bestDays);
  const next = (at) => {
    if (now >= at) return "";
    const left = at - now;
    return `Next rank in ${left} ${left === 1 ? "day" : "days"}`;
  };
  const miner = {
    title: "Miner",
    badge: "",
    portrait: "/miner-start.jpg",
    alt: "A young cheetah miner in a helmet, holding a pickaxe",
    caption: "New on the ladder. One counted send a day keeps the streak warm.",
  };
  if (days >= 84) {
    return {
      title: "Barterer",
      badge: "",
      portrait: "/barterer.jpg",
      alt: "The Barterer, a young cheetah in a red jacket with coin badges, holding a ledger",
      caption: "Eighty-four days mined. Badge on, and you get a vote on the show.",
      next: "",
    };
  }
  if (days >= 56) {
    return {
      title: "Narrator",
      badge: "",
      portrait: "/storyteller.jpg",
      alt: "The Narrator, an old cheetah reading a glowing book",
      caption: "Fifty-six days in the ledger. Your story is written down, and you see the recap first.",
      next: next(84),
    };
  }
  if (days >= 28) {
    return {
      title: "Shift Boss",
      badge: "Shift Boss Shield",
      portrait: "/cheetah-miner.jpg",
      alt: "A cheetah miner in a helmet, holding a pickaxe",
      caption: "Twenty-eight days down. The shield covers one missed day.",
      next: next(56),
    };
  }
  if (days >= 14) {
    return { ...miner, badge: "Practice Shield", next: next(28) };
  }
  return { ...miner, next: next(14) };
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
  const items = Array.isArray(miner?.shopItems) ? miner.shopItems : Array.isArray(miner?.upgrades) ? miner.upgrades : [];
  if (items.length === 0) return `Shop items owned: ${SHOP_EMPTY}`;
  return `Shop items owned: ${items.map((name) => String(name)).join(", ")}`;
}

// "Mine open", or before launch "Mine opens October 28, 8:00 PM ET" (no weekday: the ban list covers day names).
export function mineBadge({ open, opensAt } = {}) {
  if (open) return "Mine open";
  const ms = typeof opensAt === "number" ? opensAt : Date.parse(opensAt ?? "");
  if (!Number.isFinite(ms)) return refuse("Mine opens soon");
  const parts = etParts(new Date(ms));
  return refuse(`Mine opens ${MONTHS[Number(parts.month) - 1]} ${Number(parts.day)}, ${closeLabel(ms)}`);
}

function trimNumber(text) {
  const t = String(text ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return "0";
  return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
}

export function ktaTodayLine(miner) {
  const n = trimNumber(miner?.ktaToday);
  return n === "0" ? "Counted today: 0 KTA. No counted send yet today." : `Counted today: ${n} KTA`;
}

export function shareTodayLine(miner) {
  const n = trimNumber(miner?.shareToday);
  return n === "0" ? "Your share of today's KORE: None yet today." : `Your share of today's KORE: ${n}%`;
}

export function carriedLine(miner) {
  const n = trimNumber(miner?.carried);
  return n === "0" ? "Part of a KORE carried: 0 KORE" : `Part of a KORE carried: ${n} KORE`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The send block is the one place a full address is shown, so it has its own render path. Only the fire address is allowed,
// and the words around it still go through refuse().
export function sendBlock(address = FIRE) {
  if (address !== FIRE) throw new Error("only the fire address may be shown in full");
  return { lead: refuse(SEND_LEAD), address, copy: "Copy", tip: refuse(SEND_TIP), note: refuse(SEND_NOTE) };
}

export function sendBlockHtml(address = FIRE) {
  const b = sendBlock(address);
  return `<div class="send-block" id="send-block"><p>${escapeHtml(b.lead)}</p>`
    + `<p><code id="fire-address">${escapeHtml(b.address)}</code> <button type="button" id="copy-fire" data-copy="${escapeHtml(b.address)}" title="${escapeHtml(b.tip)}">${b.copy}</button></p>`
    + `<p class="send-note">${escapeHtml(b.note)}</p></div>`;
}

export async function copyFire(clipboard) {
  await clipboard.writeText(FIRE);
  return FIRE;
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
    ktaToday: ktaTodayLine(miner),
    shareToday: shareTodayLine(miner),
    carried: carriedLine(miner),
    ladderStreak,
    shieldsUsed: used,
    rank: row?.rank ?? null,
    nextRank,
    nextAt,
    daysToNext,
    progress,
    upgrades: upgradesLine(miner),
    lines: {
      ladder: row ? `Streak ${ladderStreak}${used ? ` (${usedText})` : ""}` : NO_LADDER,
      rank: row ? `Rank: ${row.rank || "none yet"}` : "Rank: none yet",
      next: row ? daysLine(daysToNext, nextRank) : "",
      shields: row ? shieldLine(row.shields) : "Shields: no ladder record yet.",
      ktaToday: ktaTodayLine(miner),
      shareToday: shareTodayLine(miner),
      carried: carriedLine(miner),
      paid: `${withCommas(paid)} KORE paid`,
      waiting: `${withCommas(waiting)} KORE waiting`,
      whole: WHOLE_NOTE,
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
