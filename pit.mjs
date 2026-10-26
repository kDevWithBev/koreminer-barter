// The pit: daily KORE pot split by counted KTA sent to the fire address. Nothing here publishes a block or reads the network.
// Port of sim v5.1 (requests/koreminer/2026-10-26-sim-v5.1.py, run_day / recover). Same field names on purpose:
// pit-check.mjs replays every sim close and compares the whole state after each step.
//
// Money rules (spec v4 ae782ff7):
//  - A send counts when it is >= 1 KTA, to FIRE, at or after the start time, from a wallet that is not excluded.
//    KORE and any other token sent to FIRE are logged as burns that count for nothing.
//  - Each UTC day's pot (dayBudget, 30,684 KORE in era 1) is split by counted KTA, sorted by address,
//    floor per row, last row takes pot - given (share.mjs carry). Sub-units: 10^12 per KORE. Fractions carry per wallet.
//  - Payouts are whole KORE, oldest due first (ties: address). Fees come only from the fee account above a 2 KTA reserve,
//    <= 0.05 KTA per staple, <= 0.5 KTA per close day.
//  - Restart safety: closed days are refused, the allocation is written once, every payout has an intent key written
//    before the send, a key that is open or sent is refused, a skipped close halts.

import { dayBudget } from "./ledger.mjs";
import { UNIT } from "./share.mjs";
import { ladderStep, rungName } from "./ladder.mjs";

export const ONE_KTA = 10n ** 18n;
export const SUB = UNIT; // 10^12 sub-units per KORE
export const FEE_RAW = 4_040_000_000_000_000n; // 0.00404 KTA, modeled fee per payout staple
export const STAPLE_CAP = 5n * 10n ** 16n; // 0.05 KTA
export const DAY_CAP = 5n * 10n ** 17n; // 0.5 KTA per close day
export const FEE_RESERVE = 2n * ONE_KTA; // same 2 KTA as share.mjs RESERVE
export const VAULT_START = 20_558_831n;
export const KTA_TOK = "KTA";
export const KORE_TOK = "KORE";
export const BURN_REASONS = ["burn_kore", "burn_token"];

export const ADDR = {
  bridge: "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle",
  intake: "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa",
  sink: "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq",
  owner: "keeta_aabjpjyagqksgavvh5ulyr5rbvcy5j3dx5q3xetcmgphug4m4wrtfeqn5oblzsy",
  kore: "keeta_apu6efya45r6rirjwyhl25djcuqg53zlepwctj7xpzvmrhfwckrzxwht4sypk",
  testA: "keeta_aabt2kigijvalt6qx6flckrowjrqyyn5rzspzbgb7myqf7vqxzigk2pyxa44era",
  testB: "keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy",
  hd2i: "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i",
  usdc: "keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna",
};
export const FIRE = ADDR.sink; // Trey, Oct 26 10:51 AM ET: the fire address is the existing sink
export const FEE_ACCOUNT = ADDR.intake; // Bob, Oct 26 10:52 AM ET: the shaft pays fees
export const TEST_WALLETS = new Set([ADDR.testA, ADDR.testB]);
export const FROZEN = new Set([ADDR.testB]);

export function makeConfig({ pitDay1, fire = FIRE, excluded = null } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pitDay1 ?? ""))) throw new Error("pit start day is not set");
  const ex = new Set(excluded ?? [ADDR.bridge, ADDR.intake, ADDR.sink, ADDR.owner, ADDR.kore, ADDR.testA, ADDR.testB]);
  ex.add(fire);
  if (ex.has(ADDR.hd2i)) throw new Error("hd2i must count");
  return { pitDay1, fire, startMs: Date.parse(`${pitDay1}T00:00:00.000Z`), excluded: ex };
}

export class Crash extends Error {}

export function nextDay(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}
export function budgetOf(day) {
  return dayBudget(Date.parse(`${day}T00:00:00Z`));
}
export function fkta(raw) {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const i = v / ONE_KTA;
  const fs = (v % ONE_KTA).toString().padStart(18, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + (fs ? `${i}.${fs}` : `${i}`);
}
export function fk(sub) {
  return `${sub / SUB}.${(sub % SUB).toString().padStart(12, "0")}`;
}
export function pct(num, den, dp = 4) {
  if (den === 0n) return `0.${"0".repeat(dp)}`;
  const s = 10n ** BigInt(dp);
  const q = (num * 100n * s) / den;
  return `${q / s}.${(q % s).toString().padStart(dp, "0")}`;
}
export function short(w) {
  return String(w).startsWith("keeta_") ? `${w.slice(0, 10)}…${w.slice(-4)}` : w;
}

export function sendKey(s) {
  return [s.block ?? s.tx, s.op ?? 0];
}
function seenKey(s) {
  const [b, o] = sendKey(s);
  return `${b}:${o}`;
}

export function classify(cfg, s, seen, testMode) {
  const k = seenKey(s);
  if (seen.has(k)) return "duplicate";
  seen.add(k);
  if (s.to !== cfg.fire) return "wrong_to";
  if (s.timeMs < cfg.startMs) return "before_start";
  if (s.token === KORE_TOK) return "burn_kore";
  if (s.token !== KTA_TOK) return "burn_token";
  if (s.amount < ONE_KTA) return "sub_1";
  if (cfg.excluded.has(s.from) && !(testMode && TEST_WALLETS.has(s.from))) return "excluded";
  return "counted";
}
export function payable(cfg, w, testMode) {
  return !cfg.excluded.has(w) || (testMode && TEST_WALLETS.has(w));
}

export function createPit({ feeGross = null, ladder = null, ladderLast = null, feeQuotes = [] } = {}) {
  return {
    seen: new Set(), pending: {}, paid: {}, lots: {},
    budget_total: 0n, alloc_total: 0n, kept_total: 0n, paid_total: 0n, cutover_unissued: 0n,
    vault_start: VAULT_START, vault: VAULT_START,
    fee_gross: feeGross, fee_gross_start: feeGross,
    fee_spent: {}, intents: {}, chain: [], closed: {}, alloc: {},
    last_pit_closed: null, ladder: ladder ?? {}, lmeta: { last: ladderLast },
    fee_quotes: [...feeQuotes], sent_hist: [], carry_run: 0, fee_low_alerted: false,
    payouts: [], lev: [], alerts: [], flags: [], burns: [],
  };
}

const g = (o, k) => o[k] ?? 0n;
export function wholeDue(pit, w) {
  return g(pit.pending, w) / SUB - g(pit.paid, w);
}
export function payKey(pit, w) {
  return `kore-${w}-${g(pit.pending, w) / SUB}`; // same shape as live pay.mjs `kore-${from}-${counted}`
}

// The state write after a send landed. Never applied twice.
export function applyPaid(pit, key) {
  const it = pit.intents[key];
  if (!it || it.status !== "intent") throw new Error(`apply_paid on ${key} with status ${it?.status}`);
  if (wholeDue(pit, it.w) !== it.amt) throw new Error(`due changed under an open intent ${key}`);
  pit.paid[it.w] = g(pit.paid, it.w) + it.amt;
  pit.paid_total += it.amt;
  pit.lots[it.w] = [];
  it.status = "sent";
  pit.payouts.push([it.day, it.w, it.amt, it.since]);
}
// The chain side of a payout (the sim's on-chain record). The runner calls it once the KORE balance shows the send landed.
export function recordSend(pit, key) {
  const it = pit.intents[key];
  pit.chain.push([key, it.w, it.amt, it.fee, it.day]);
  pit.vault -= it.amt;
  if (pit.fee_gross !== null) pit.fee_gross -= it.fee;
}
// Restart: settle every open intent. landed(key) says whether the send is on chain.
export function recover(pit, landed = (key) => pit.chain.some((c) => c[0] === key)) {
  const out = [];
  for (const key of Object.keys(pit.intents).sort()) {
    const it = pit.intents[key];
    if (it.status !== "intent") continue;
    if (landed(key)) {
      if (!pit.chain.some((c) => c[0] === key)) recordSend(pit, key);
      applyPaid(pit, key);
      out.push([key, "landed->state written"]);
    } else {
      it.status = "void";
      pit.fee_spent[it.day] -= it.fee;
      out.push([key, "not on chain->void, stays queued"]);
    }
  }
  return out;
}

function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// The day's pot split (spec v4 §4.2), the same carry rule as share.mjs rowsOf/accrue: rows sorted by address, zero rows dropped,
// floor per row, the last row takes pot - given. Kept here so share.mjs and pay.mjs (md5-pinned by base-credit-check) stay as reviewed.
export function splitPot(pot, miners) {
  const rows = Object.entries(miners).filter(([, a]) => a > 0n).sort((x, y) => cmpStr(x[0], y[0]));
  if (pot <= 0n || rows.length === 0) return [];
  const stake = rows.reduce((sum, [, a]) => sum + a, 0n);
  let given = 0n;
  return rows.map(([from, amount], index) => {
    const share = index === rows.length - 1 ? pot - given : (pot * amount) / stake;
    given += share;
    return { from, amount, share };
  });
}

// Step 1 of a close. Returns {refused}, {halt}, or {A, resumed}.
export function allocate(cfg, pit, day, sends, { testMode = false, ladderOn = true, crash = null } = {}) {
  if (pit.closed[day]) {
    pit.alerts.push([day, "REFUSED_RECLOSE", "day already closed; stored result returned, nothing changed"]);
    return { refused: "reclose", day, stored: pit.closed[day] };
  }
  const isPit = day >= cfg.pitDay1;
  if (isPit && pit.last_pit_closed !== null && day !== nextDay(pit.last_pit_closed)) {
    if (day < pit.last_pit_closed) {
      pit.alerts.push([day, "REFUSED_OUT_OF_ORDER", `last closed ${pit.last_pit_closed}`]);
      return { refused: "out_of_order", day };
    }
    const missing = [];
    for (let d = nextDay(pit.last_pit_closed); d < day; d = nextDay(d)) missing.push(d);
    pit.alerts.push([day, "HALT_SKIPPED_CLOSE", `unclosed days [${missing.map((d) => `'${d}'`).join(", ")}]: backfill them in order from chain first`]);
    return { halt: "skipped_close", day, missing };
  }
  if (pit.alloc[day]) return { A: pit.alloc[day], resumed: true, isPit };
  const per = {}; const miners = {}; const ignored = []; let ignRaw = 0n; const burns = [];
  const sorted = [...sends].sort((x, y) => cmpStr(x.time, y.time) || cmpStr(String(sendKey(x)[0]), String(sendKey(y)[0])) || cmpStr(String(sendKey(x)[1]), String(sendKey(y)[1])));
  for (const s of sorted) {
    if (s.time.slice(0, 10) !== day) throw new Error(`send ${s.tx} is not on ${day}`);
    const r = classify(cfg, s, pit.seen, testMode);
    const row = per[s.from] ?? (per[s.from] = { counted: 0, ign: {}, raw: 0n });
    if (r === "counted") {
      row.counted += 1; row.raw += s.amount; miners[s.from] = (miners[s.from] ?? 0n) + s.amount;
    } else {
      row.ign[r] = (row.ign[r] ?? 0) + 1;
      if (r !== "duplicate" && !BURN_REASONS.includes(r) && s.token === KTA_TOK) ignRaw += s.amount;
      const [b, o] = sendKey(s);
      ignored.push({ day, tx: s.tx, block: b, op: o, from: s.from, reason: r });
      if (BURN_REASONS.includes(r)) {
        burns.push({ day_utc: day, block: b, op: o, from: s.from, token: s.token, amount_raw: s.amount, kind: r, counts_for_mining: 0, test_mode: testMode ? "TEST" : "" });
      }
    }
  }
  if (!isPit && Object.keys(miners).length) throw new Error("counted send before the pit opened");
  const budget = isPit ? budgetOf(day) : 0n;
  const pot = budget * SUB;
  const rows = splitPot(pot, miners);
  const allocated = rows.reduce((a, r) => a + r.share, 0n);
  const kept = pot - allocated;
  const total = Object.values(miners).reduce((a, v) => a + v, 0n);
  const floorSum = rows.length ? rows.reduce((a, r) => a + (pot * r.amount) / total, 0n) : 0n;
  const shareOf = {};
  for (const r of rows) {
    const w = r.from; const old = g(pit.pending, w) / SUB;
    pit.pending[w] = g(pit.pending, w) + r.share; shareOf[w] = r.share;
    const nw = pit.pending[w] / SUB;
    if (nw > old) (pit.lots[w] ?? (pit.lots[w] = [])).push([day, nw - old]);
  }
  pit.budget_total += pot; pit.alloc_total += allocated; pit.kept_total += kept;
  if (!isPit && day >= "2026-10-26") pit.cutover_unissued += budgetOf(day);
  pit.burns.push(...burns);
  if (ladderOn && isPit) ladderStep(pit.ladder, pit.lmeta, day, new Set(Object.keys(miners)), pit.lev);
  const A = { per, miners, ignored, ign_raw: ignRaw, budget, pot, rows, allocated, kept, total, floor_sum: floorSum, share_of: shareOf, burns };
  pit.alloc[day] = A;
  if (crash && crash[0] === "before_alloc_write") throw new Crash("before the allocation state write");
  return { A, resumed: false, isPit };
}

// Step 2: the payout queue for this close, oldest due first.
export function startQueue(pit, { queue = "fifo" } = {}) {
  const due = Object.keys(pit.pending).filter((w) => wholeDue(pit, w) > 0n).map((w) => [w, wholeDue(pit, w)]);
  if (queue === "fifo") due.sort((a, b) => cmpStr(pit.lots[a[0]][0][0], pit.lots[b[0]][0][0]) || cmpStr(a[0], b[0]));
  else due.sort((a, b) => (a[1] === b[1] ? cmpStr(a[0], b[0]) : a[1] > b[1] ? -1 : 1));
  return { due, i: 0 };
}
// Next wallet to pay, after the payout-time exclusion and repeat-key guards. null when the queue is empty.
export function queueNext(cfg, pit, day, q, { testMode = false } = {}) {
  while (q.i < q.due.length) {
    const [w, d] = q.due[q.i++];
    if (!payable(cfg, w, testMode)) { pit.alerts.push([day, "EXCLUDED_AT_PAYOUT", w]); continue; }
    const key = payKey(pit, w);
    const it = pit.intents[key];
    if (it && (it.status === "intent" || it.status === "sent")) { pit.alerts.push([day, "REFUSED_REPEAT_KEY", key]); continue; }
    return { w, d, key };
  }
  return null;
}
// Fee guard for one payout. Returns null when it may go, or the stop status.
export function judgeFee(pit, day, fee) {
  if (fee > STAPLE_CAP) return { stop: "held_fee_over_cap", alert: "ALERT_FEE_OVER_CAP" };
  if (g(pit.fee_spent, day) + fee > DAY_CAP) return { stop: "day_cap" };
  if (pit.fee_gross !== null && pit.fee_gross - FEE_RESERVE < fee) return { stop: "fee_low", alert: "ALERT_FEE_LOW" };
  return null;
}
export function noteFeeStop(pit, day, cand, fee, judged) {
  if (judged.alert === "ALERT_FEE_OVER_CAP") pit.alerts.push([day, "ALERT_FEE_OVER_CAP", `${fkta(fee)} KTA > 0.05 for ${cand.w}; queue stops, retried next close`]);
  if (judged.alert === "ALERT_FEE_LOW" && !pit.fee_low_alerted) {
    pit.alerts.push([day, "ALERT_FEE_LOW", `spendable ${fkta(pit.fee_gross - FEE_RESERVE)} KTA < fee; queue stopped, no HALT`]);
    pit.fee_low_alerted = true;
  }
}
// Write-ahead: the intent and the fee reservation are saved before the send is published.
export function openIntent(pit, day, cand, fee) {
  if (cand.d < 1n) throw new Error("payout below 1 KORE");
  pit.intents[cand.key] = { status: "intent", w: cand.w, amt: cand.d, fee, day, since: pit.lots[cand.w][0][0] };
  pit.fee_spent[day] = g(pit.fee_spent, day) + fee;
  return pit.intents[cand.key];
}

// Step 3: the day row. Runs once the queue stops; marks the day closed.
export function finishClose(cfg, pit, day, A, resumed, status, { testMode = false, queued = 0 } = {}) {
  if (pit.fee_gross !== null && pit.fee_gross - FEE_RESERVE >= FEE_RAW) pit.fee_low_alerted = false;
  for (const w of Object.keys(pit.pending)) {
    const lots = pit.lots[w] ?? [];
    if (lots.reduce((a, [, n]) => a + n, 0n) !== wholeDue(pit, w)) throw new Error(`lot bookkeeping ${w}`);
    if (!lots.every(([d]) => d <= day)) throw new Error(`due_since in the future ${w}`);
  }
  const isPit = day >= cfg.pitDay1;
  const sentDay = pit.chain.filter((c) => c[4] === day).length;
  pit.sent_hist.push(sentDay);
  const carryN = Object.keys(pit.pending).filter((w) => wholeDue(pit, w) > 0n).length;
  pit.carry_run = carryN > 0 ? pit.carry_run + 1 : 0;
  if (pit.carry_run === 3) pit.flags.push([day, "FLAG_QUEUE_CARRYOVER_3_CLOSES", `${carryN} wallets still due after 3 closes -> Bob`]);
  let runway = null; let feeLow = 0;
  if (pit.fee_gross !== null) {
    const sp = pit.fee_gross - FEE_RESERVE;
    const spendN = (sp > 0n ? sp : 0n) / FEE_RAW;
    const trail = pit.sent_hist.slice(-7);
    const tot7 = BigInt(trail.reduce((a, v) => a + v, 0));
    const n = BigInt(trail.length);
    runway = (spendN * n) / (n > tot7 ? n : tot7);
    if (runway < 3n) { feeLow = 1; pit.flags.push([day, "FLAG_FEE_LOW", `runway ${runway} days < 3 (spendable ${fkta(pit.fee_gross - FEE_RESERVE)} KTA)`]); }
  }
  const carryTotal = Object.values(pit.pending).reduce((a, p) => a + (p % SUB), 0n);
  const unpaidWhole = Object.keys(pit.pending).reduce((a, w) => a + wholeDue(pit, w), 0n);
  const rows = A.rows; const pot = A.pot;
  let top = null;
  for (const r of rows) if (!top || r.share > top.share) top = r;
  const row = {
    day_utc: day, pit_day: isPit ? 1 : 0, budget: A.budget, allocated_subunits: A.allocated, kept_subunits: A.kept,
    burners: rows.length, kta_counted_raw: A.total, kta_ignored_raw: A.ign_raw, burns_logged: A.burns.length,
    remainder_row_wallet: rows.length ? rows[rows.length - 1].from : "", remainder_subunits: rows.length ? pot - A.floor_sum : 0n,
    top_share_pct: top ? pct(top.share, pot) : "0.0000",
    payouts_queued: queued, payouts_sent_modeled: sentDay, modeled_fees_kta: fkta(g(pit.fee_spent, day)),
    fee_gross_kta: pit.fee_gross === null ? "unbounded" : fkta(pit.fee_gross),
    fee_spendable_kta: pit.fee_gross === null ? "unbounded" : fkta(pit.fee_gross - FEE_RESERVE > 0n ? pit.fee_gross - FEE_RESERVE : 0n),
    runway_days: runway === null ? "" : runway, fee_low: feeLow, close_status: status, resumed: resumed ? 1 : 0,
    queue_carryover: carryN, carried_fraction_total_subunits: carryTotal, allocated_unpaid_whole: unpaidWhole,
    cutover_unissued_whole: pit.cutover_unissued, test_mode: testMode ? "TEST" : "",
  };
  const wallets = [...new Set([...Object.keys(A.per), ...Object.keys(pit.pending)])].sort();
  const wrows = wallets.map((w) => {
    const r = A.per[w] ?? { counted: 0, ign: {}, raw: 0n };
    const p = g(pit.pending, w); const lw = pit.ladder[w];
    const lots = pit.lots[w];
    return {
      day_utc: day, wallet: w, sends_counted: r.counted,
      sends_ignored: Object.keys(r.ign).sort().map((k) => `${k}:${r.ign[k]}`).join(";"),
      kta_counted_raw: r.raw, share_subunits: A.share_of[w] ?? 0n,
      paid_today_whole: pit.chain.filter((c) => c[4] === day && c[1] === w).reduce((a, c) => a + c[2], 0n),
      kore_whole_due: wholeDue(pit, w), due_since_day: lots && lots.length ? lots[0][0] : "",
      allocated_unpaid_subunits: p - g(pit.paid, w) * SUB, carry_subunits: p % SUB, paid_total_whole: g(pit.paid, w),
      streak: lw ? lw.streak : 0, shields_held: lw ? lw.shields : 0, rank: lw && lw.best >= 0 ? rungName(lw.best) : "",
      frozen: lw && lw.frozen ? 1 : 0, test_mode: testMode ? "TEST" : "",
    };
  });
  const out = { day: row, wrows, ignored: A.ignored, rows, pot, share_of: A.share_of, miners: { ...A.miners }, burns: A.burns };
  pit.closed[day] = row;
  if (isPit) pit.last_pit_closed = day;
  return out;
}

// One whole close in a single call, as the sim runs it. `send(intent)` stands in for publishing (the tests and dry runs).
export function closeDay(cfg, pit, day, sends, { testMode = false, queue = "fifo", ladderOn = true, crash = null, quote = null } = {}) {
  const a = allocate(cfg, pit, day, sends, { testMode, ladderOn, crash });
  if (!a.A) return a;
  const q = startQueue(pit, { queue });
  const queuedLen = q.due.length;
  let status = "paid"; let sentNow = 0;
  for (;;) {
    const cand = queueNext(cfg, pit, day, q, { testMode });
    if (!cand) break;
    const fee = quote ? quote(cand) : (pit.fee_quotes.length ? pit.fee_quotes.shift() : FEE_RAW);
    const judged = judgeFee(pit, day, fee);
    if (judged) { noteFeeStop(pit, day, cand, fee, judged); status = judged.stop; break; }
    openIntent(pit, day, cand, fee);
    if (crash && crash[0] === "before_send" && Number(crash[1]) === sentNow) throw new Crash("intent written, send not published");
    recordSend(pit, cand.key);
    if (crash && crash[0] === "after_send" && Number(crash[1]) === sentNow) throw new Crash("send landed, state not written");
    applyPaid(pit, cand.key);
    sentNow += 1;
    if (crash && crash[0] === "after_state" && Number(crash[1]) === sentNow) throw new Crash("state written after a payout");
  }
  return finishClose(cfg, pit, day, a.A, a.resumed, status, { testMode, queued: queuedLen });
}

// ---- persistence (BigInt as strings) ----
export function pitToJson(pit) {
  return JSON.stringify(pit, (k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Set ? { $set: [...v].sort() } : v));
}
export function pitFromJson(text) {
  return JSON.parse(text, (k, v) => {
    if (typeof v === "string" && /^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1));
    if (v && typeof v === "object" && Array.isArray(v.$set)) return new Set(v.$set);
    return v;
  });
}
