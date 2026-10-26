// The pit runner (new model). Started by run.mjs main() when /opt/koreminer/pit-config.json exists.
// Watches the fire address, closes each UTC day in order, pays whole KORE oldest due first from the shaft.
// Money logic lives in pit.mjs (replayed against sim v5.1 by pit-check.mjs). This file is the chain and file plumbing.
//
// Files (all under dir, or dir/pit-test in test mode):
//   pit-config.json  (dir only)  {"pitDay1":"YYYY-MM-DD", "startTime"?: ISO, "test"?: bool, "ladderSeed": path, "ladderSeedMd5": hex,
//                                 "ladderLast"?: "YYYY-MM-DD", "closeGraceMs"?: ms, "publicDir"?: path}
//   pit-state.json   the whole pit (pit.mjs) plus the runner's publish log, written atomically (tmp + fsync + rename) before
//                    every send and when a pass ends; never written from the error handler (Sage M1)
//   pit-state.json.bak  the previous pit-state.json, kept on every write
//   pit-sends.json   every op seen to the fire address, by UTC day, plus the history cursor and late sends
//   pit-alerts.log   one line per new alert or flag
//   pit-days.csv / pit-burns.csv / pit-lookup.json / pit-ladder.json   outputs, rebuilt each pass
//   pit-init.used    the consumed one-time init file (Ops R-B3)
// dir only: pit-init (one-time, Trey creates it: {"pitDay1": "...", "mode": "live"|"test"}; consumed on the first start),
//   SEND ("on" arms KORE sends, live), STOP. HALT and PAYHOLD are written to dir in live mode and to dir/pit-test in test
//   mode (Sage S5); a HALT in either place stops the runner.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync, appendFileSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  ADDR, DAY_CAP, FEE_RAW, FEE_RESERVE, FROZEN, KTA_TOK, ONE_KTA, STAPLE_CAP, SUB, TEST_WALLETS,
  allocate, classify, createPit, finishClose, judgeFee, makeConfig, nextDay, noteFeeStop, openIntent,
  payable, pitFromJson, pitToJson, queueNext, recordSend, applyPaid, recover, startQueue, wholeDue, pct,
} from "./pit.mjs";
import { seedLadder, rungName, RUNGS } from "./ladder.mjs";
import { findKeyedSends, headAgreed, pullSince, readFireStaple } from "./chain.mjs";
import { minPublishGapMs } from "./pace.mjs";
import { floorAfter, judgeIntent } from "./pay.mjs";

export const EXPIRE_MS = 6 * 60 * 1000; // a signed block that has not landed in 6 minutes cannot gather votes
const DAY_MS = 86_400_000;

export class FeeStop extends Error {}

// Spec rates (same as the legacy runner): 60 publishes and 3.0 KTA of fees per rolling hour, a gap of 3600 s / 60 between
// publishes, and 0.5 KTA of fees per wall-clock UTC day on top of the 0.5 per close day (Ops R-B2, Sage S2).
export const PACE = { perHour: 60, hourFee: 3n * ONE_KTA, wallDayFee: DAY_CAP, gapMs: minPublishGapMs(60) };
const HOUR_MS = 3_600_000;
export const STUCK_MS = 30 * 60 * 1000; // a pending block with no readable date this long: alert + PAYHOLD
// Ops B-1: settle searches the shaft history from this long before the intent time, so a box clock that runs fast (the
// staple is stamped before it.at) still finds the key.
export const SETTLE_LOOKBACK_MS = 15 * 60 * 1000;
const KEEP_ALLOC_DAYS = 14; // alloc detail kept for the last 14 closed days (the day rows stay forever)
const KEEP_ALERTS = 5_000; // alerts and flags kept in state; every one is also in pit-alerts.log

// tmp + fsync + rename + fsync of the folder (Ops nb4). The old file is kept as .bak when asked.
function writeJson(path, text, { bak = false } = {}) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  if (bak && existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(tmp, path);
  try { const d = openSync(dirname(path), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* some filesystems refuse a folder fsync */ }
}
const big = (k, v) => (typeof v === "bigint" ? `${v}n` : v);
const BIG_RE = /^(0|-?[1-9]\d*)n$/; // strict: what big() writes and nothing else (Ops nb7)
const unbig = (k, v) => (typeof v === "string" && BIG_RE.test(v) ? BigInt(v.slice(0, -1)) : v);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (d) => typeof d === "string" && DAY_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
const CONFIG_KEYS = new Set(["pitDay1", "startTime", "test", "ladderSeed", "ladderSeedMd5", "ladderLast", "closeGraceMs", "publicDir", "fire"]);

// The whole config is checked here, before anything is read or written (Sage M1, S3). Any doubt refuses the start.
export function readConfig(dir) {
  const path = `${dir}/pit-config.json`;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("pit-config.json is not an object");
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.has(k)) throw new Error(`pit-config.json has an unknown key: ${k}`);
  if (!isDay(raw.pitDay1)) throw new Error("pitDay1 must be a real UTC day, YYYY-MM-DD");
  const cfg = makeConfig({ pitDay1: raw.pitDay1 });
  if (raw.test !== undefined && typeof raw.test !== "boolean") throw new Error("test must be true or false");
  cfg.test = raw.test === true;
  if (raw.startTime !== undefined) {
    const ms = Date.parse(raw.startTime);
    if (typeof raw.startTime !== "string" || !Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== cfg.pitDay1) throw new Error("startTime must be a time on pitDay1 (UTC)");
    // S3: spec l.76 counts from pit day 1 00:00:00Z. A later start in live mode would give the whole pot to later senders.
    if (!cfg.test && ms !== cfg.startMs) throw new Error("live mode: startTime must be pitDay1 00:00:00Z or left out");
    cfg.startMs = ms;
  }
  if (raw.fire !== undefined && raw.fire !== cfg.fire) throw new Error("fire address in pit-config.json does not match the code");
  if (typeof raw.ladderSeed !== "string" || !raw.ladderSeed.startsWith("/") || !/^[0-9a-f]{32}$/.test(String(raw.ladderSeedMd5 ?? ""))) throw new Error("ladderSeed (absolute path) and ladderSeedMd5 are required");
  cfg.ladderSeed = raw.ladderSeed;
  cfg.ladderSeedMd5 = raw.ladderSeedMd5;
  // M1: a wrong ladderLast is what made allocate throw half-way. It must be the day before pit day 1.
  cfg.ladderLast = raw.ladderLast ?? prevDay(cfg.pitDay1);
  if (!isDay(cfg.ladderLast) || cfg.ladderLast !== prevDay(cfg.pitDay1)) throw new Error(`ladderLast must be ${prevDay(cfg.pitDay1)} (the day before pitDay1)`);
  cfg.closeGraceMs = raw.closeGraceMs === undefined ? 10 * 60 * 1000 : raw.closeGraceMs;
  if (!Number.isInteger(cfg.closeGraceMs) || cfg.closeGraceMs < 60_000 || cfg.closeGraceMs > 6 * HOUR_MS) throw new Error("closeGraceMs must be a whole number of ms from 60000 to 21600000");
  cfg.publicDir = raw.publicDir ?? "/var/www/koreminer";
  if (typeof cfg.publicDir !== "string" || !cfg.publicDir.startsWith("/")) throw new Error("publicDir must be an absolute path");
  return cfg;
}

// A fresh pit: the ladder comes from the md5-checked Oct 25 snapshot; aabz6zxb stays frozen as it is there.
export function freshPit(cfg) {
  const body = readFileSync(cfg.ladderSeed);
  const md5 = createHash("md5").update(body).digest("hex");
  if (md5 !== cfg.ladderSeedMd5) throw new Error(`ladder seed md5 ${md5} is not ${cfg.ladderSeedMd5}`);
  const ladder = seedLadder(JSON.parse(body), { frozen: FROZEN });
  return createPit({ ladder, ladderLast: cfg.ladderLast });
}

// Shield display for card.js ({practice:{held,used}, shiftBoss:{held,used}}): the pit keeps a pool; shields are used oldest first.
export function shieldView(lw) {
  const practice = lw.practice_given ? 1 : 0;
  const used = lw.used_total;
  const pUsed = practice === 1 && used >= 1;
  const pHeld = practice === 1 && !pUsed && lw.shields > 0;
  const sbHeld = lw.shields - (pHeld ? 1 : 0) > 0;
  const sbUsed = lw.shift_boss_grants > 0 && used > practice;
  return { practice: { held: pHeld, used: pUsed }, shiftBoss: { held: sbHeld, used: sbUsed } };
}

function short(w) { return `${w.slice(0, 10)}…${w.slice(-4)}`; }
function frac2(sub) { // part of a KORE, two places, rounded down
  return `0.${((sub % SUB) * 100n / SUB).toString().padStart(2, "0")}`;
}
function kta2(raw) { // whole KTA with up to 2 places, rounded down
  const c = raw * 100n / ONE_KTA;
  return `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;
}

// The open mine day as the card shows it: counted KTA per wallet so far today. Reads only; seen is copied.
export function openDayView(cfg, pit, sends, testMode) {
  const seen = new Set(pit.seen);
  const miners = {};
  for (const s of sends) {
    if (classify(cfg, s, seen, testMode) === "counted") miners[s.from] = (miners[s.from] ?? 0n) + s.amount;
  }
  const total = Object.values(miners).reduce((a, v) => a + v, 0n);
  return { miners, total };
}

// Public lookup + ladder in the shape card.js reads. Excluded and frozen wallets are hidden (test wallets too, live).
export function publicViews(cfg, pit, { today, todaySends, testMode, updated }) {
  const open = openDayView(cfg, pit, todaySends, testMode);
  const hidden = (w) => cfg.excluded.has(w) && !(testMode && TEST_WALLETS.has(w)) || FROZEN.has(w) && !testMode;
  const wallets = [...new Set([...Object.keys(pit.pending), ...Object.keys(pit.ladder), ...Object.keys(open.miners)])].filter((w) => !hidden(w)).sort();
  const miners = {}; const rows = []; const rungs = Object.fromEntries(RUNGS.map(([, n]) => [n, 0]));
  for (const w of wallets) {
    const lw = pit.ladder[w];
    const k = open.miners[w] ?? 0n;
    miners[w] = {
      streak: lw ? lw.streak : 0,
      paid: String(pit.paid[w] ?? 0n),
      waiting: String(wholeDue(pit, w) > 0n ? wholeDue(pit, w) : 0n),
      carried: frac2(pit.pending[w] ?? 0n),
      ktaToday: kta2(k),
      shareToday: k > 0n ? pct(k, open.total, 2) : "",
    };
    if (lw) {
      const best = lw.best;
      if (best >= 0) rungs[RUNGS[best][1]] += 1;
      // Sage M3: the next rung is the one above the best rung reached, not above the current streak.
      const next = RUNGS[best + 1] ?? null;
      rows.push({
        wallet: short(w), ladderStreak: lw.streak, streak: lw.streak, rank: best >= 0 ? rungName(best) : null,
        nextRank: next ? next[1] : null, nextAt: next ? next[0] : null, shields: shieldView(lw), shieldsUsed: lw.used_total,
      });
    }
  }
  const stamp = testMode ? { test: "TEST" } : {};
  return {
    lookup: { ...stamp, updated, mode: "pit", day: today, miners },
    ladder: { ...stamp, mode: "pit", rungs, wallets: rows },
  };
}

function csv(rows) {
  if (!rows.length) return "";
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]; // union: late burns add a late column
  return [keys.join(","), ...rows.map((r) => keys.map((k) => String(r[k] ?? "")).join(","))].join("\n") + "\n";
}

// ---- fee handling (same rules as run.mjs selectFee / cappedFeeBlock: KTA only, under the cap, built block checked) ----
function tokenText(t) {
  if (!t) return "";
  if (typeof t === "string") return t;
  const k = t.publicKeyString;
  return typeof k?.toString === "function" ? k.toString() : "";
}
export function pickFee(fee, baseText) {
  const list = fee == null ? [] : Array.isArray(fee) ? fee : [fee];
  if (!list.length) return { kind: "none", amount: 0n };
  if (list.some((f) => f && typeof f.amount === "bigint" && f.amount === 0n)) return { kind: "free", amount: 0n };
  for (const f of list) {
    let a = null; try { a = f?.amount == null || f.amount === "" ? null : BigInt(f.amount); } catch { a = null; }
    if (a === null) continue;
    const tt = tokenText(f?.token);
    if (!tt || tt === baseText) return { kind: "kta", amount: a };
  }
  return { kind: "foreign", amount: 0n };
}
export function quoteTotal(quotes, baseText) {
  if (!quotes?.length) return { usable: false, amount: 0n, foreign: false };
  let amount = 0n; let usable = false; let foreign = false;
  for (const q of quotes) {
    const p = pickFee(q?.fee, baseText);
    if (p.kind === "none") continue;
    usable = true;
    if (p.kind === "foreign") foreign = true;
    amount += p.amount;
  }
  return { usable, amount, foreign };
}

export async function runPit({
  dir = "/opt/koreminer", client, base, baseText, koreAccount, accountFrom, testFlag = false,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), steps = Infinity,
  log = console.log, warn = console.error, pace = {},
} = {}) {
  const cfg = readConfig(dir);
  const testMode = cfg.test || testFlag;
  const sd = testMode ? `${dir}/pit-test` : dir;
  const P = (n) => `${sd}/${n}`;
  const T = testMode ? "TEST " : "";
  const R = { ...PACE, ...pace };
  // S4: an empty token id would make "" === "" map a token-less op to KTA. The KORE id must be the code's.
  const koreText = tokenText(koreAccount);
  if (typeof baseText !== "string" || !baseText.startsWith("keeta_")) throw new Error("KTA token id is empty; refusing to start");
  if (koreText !== ADDR.kore) throw new Error("KORE token id is empty or not the KORE token; refusing to start");
  mkdirSync(sd, { recursive: true });
  // S5: test mode never writes HALT or PAYHOLD into the live folder.
  const hold = (reason) => { writeFileSync(P("PAYHOLD"), `${reason}\n`); warn(`${T}KORE sends wait. ${reason}`); };
  const halt = (reason) => { writeFileSync(P("HALT"), `${reason}\n`); warn(`${T}HALT. ${reason}`); };
  const stopped = () => existsSync(`${dir}/STOP`) || existsSync(`${dir}/HALT`) || existsSync(P("HALT"));
  if (stopped()) { log(`${T}Stop file present. Not running.`); return; }
  const refuse = (reason) => { halt(reason); throw new Error(reason); };

  // Ops nb5: never start over an open payout left by the legacy runner.
  if (existsSync(`${dir}/payout-intent.json`)) refuse("legacy payout-intent.json is open; settle it with the legacy runner first");

  const readPit = () => pitFromJson(readFileSync(P("pit-state.json"), "utf8"));
  const readStore = () => (existsSync(P("pit-sends.json")) ? JSON.parse(readFileSync(P("pit-sends.json"), "utf8"), unbig) : { cursor: "", byDay: {}, keys: [], late: [], lateSends: [] });
  let pit; let fresh = false;
  if (existsSync(P("pit-state.json"))) {
    pit = readPit();
  } else {
    // Ops R-B3: a missing state next to any pit output means the state was lost, not that this is a first start.
    const left = ["pit-state.json.bak", "pit-sends.json", "pit-days.csv", "pit-alerts.log", "pit-burns.csv", "pit-lookup.json", "pit-ladder.json", "pit-init.used"].filter((n) => existsSync(P(n)));
    if (left.length) refuse(`pit-state.json is missing but ${left.join(", ")} exist; refusing to seed a fresh pit (restore pit-state.json or pit-state.json.bak)`);
    let init = null;
    try { init = JSON.parse(readFileSync(`${dir}/pit-init`, "utf8")); } catch { init = null; }
    if (!init) refuse("no pit-state.json and no pit-init; a first start needs the one-time pit-init file");
    if (init.pitDay1 !== cfg.pitDay1 || init.mode !== (testMode ? "test" : "live")) refuse(`pit-init is for ${init.pitDay1} ${init.mode}, config is ${cfg.pitDay1} ${testMode ? "test" : "live"}`);
    if (!testMode) {
      // Any pit-shaped KORE send from the shaft since pit day 1 means a pit already paid from this vault.
      const legacyUntil = init.legacyUntil === undefined ? null : Date.parse(init.legacyUntil);
      if (init.legacyUntil !== undefined && !Number.isFinite(legacyUntil)) refuse("pit-init legacyUntil is not a time");
      // Ops N-3: pit and legacy keys share the kore-<wallet>-<n> shape. The first pit payout cannot exist before pit day 1
      // has ended, and settle looks back SETTLE_LOOKBACK_MS before a day's end (Ops N-6), so a legacyUntil at or after
      // start + 1 day - 15 min could hide pit sends: refuse it.
      if (legacyUntil !== null && legacyUntil >= cfg.startMs + DAY_MS - SETTLE_LOOKBACK_MS) refuse(`pit-init legacyUntil ${init.legacyUntil} is not before pit day 1 end - 15 min; it could hide pit sends`);
      const h = await findKeyedSends(client, ADDR.intake, { sinceMs: cfg.startMs, koreText });
      if (!h.complete) refuse("shaft history since pit day 1 is incomplete; refusing to seed");
      const hits = h.sends.filter((s) => s.timeMs >= cfg.startMs && !(legacyUntil !== null && s.timeMs <= legacyUntil) && s.externals.some((e) => e.startsWith("kore-")));
      if (hits.length) refuse(`${hits.length} keyed KORE sends from the shaft since ${cfg.pitDay1}; refusing to seed a fresh pit`);
    }
    pit = freshPit(cfg);
    pit.run = { pitDay1: cfg.pitDay1, test: testMode, fire: cfg.fire, startMs: cfg.startMs };
    fresh = true;
  }
  // M1: the state must belong to this config, and the ladder must be where the closes say it is.
  if (!pit.run || pit.run.pitDay1 !== cfg.pitDay1 || pit.run.test !== testMode || pit.run.fire !== cfg.fire || pit.run.startMs !== cfg.startMs) {
    refuse(`pit-state.json was made for ${JSON.stringify(pit.run ?? null)}, not this config`);
  }
  const openAlloc = Object.keys(pit.alloc).filter((d) => !pit.closed[d]).sort();
  const wantLast = openAlloc.at(-1) ?? pit.last_pit_closed ?? cfg.ladderLast;
  if (openAlloc.length > 1 || pit.lmeta?.last !== wantLast) refuse(`ladder last day ${pit.lmeta?.last} does not match the closes (${wantLast})`);
  pit.pub_log ??= [];
  pit.stuck_since ??= null; // Ops N-2: first time a dateless pending block was seen, kept in the state across restarts

  let store = readStore();
  let keys = new Set(store.keys);
  let late = new Set(store.late ?? []);
  let noted = { alerts: pit.alerts.length, flags: pit.flags.length };

  const DEDUPE = new Set(["EXCLUDED_AT_PAYOUT", "FEE_WALL_DAY_CAP", "PAYOUT_WAIT_HISTORY", "PAYOUT_UNPROVEN", "PENDING_EXPIRED", "PENDING_STUCK"]);
  function prune() {
    // Repeats of the same alert (same day, kind, detail) are dropped (Ops nit 6: queue resumes re-check exclusions).
    const seenA = new Set(pit.alerts.slice(0, noted.alerts).map((a) => a.join("|")));
    pit.alerts = pit.alerts.filter((a, i) => {
      if (i < noted.alerts || !DEDUPE.has(a[1])) return true;
      const k = a.join("|"); if (seenA.has(k)) return false; seenA.add(k); return true;
    });
    // Ops nb8: bound the state. Old alloc detail goes (the day rows stay), and old publish log entries.
    if (pit.last_pit_closed) {
      const cut = new Date(Date.parse(`${pit.last_pit_closed}T00:00:00Z`) - KEEP_ALLOC_DAYS * DAY_MS).toISOString().slice(0, 10);
      for (const d of Object.keys(pit.alloc)) if (pit.closed[d] && d < cut) delete pit.alloc[d];
    }
    const t = now();
    pit.pub_log = pit.pub_log.filter((e) => e.ms > t - 2 * DAY_MS);
  }
  function save() {
    prune();
    writeJson(P("pit-state.json"), pitToJson(pit), { bak: true });
    for (const [kind] of [["alerts"], ["flags"]]) {
      for (const a of pit[kind].slice(noted[kind])) {
        const line = `${new Date(now()).toISOString()} ${T}${a.join(" ")}`;
        appendFileSync(P("pit-alerts.log"), `${line}\n`);
        warn(line);
      }
      if (pit[kind].length > KEEP_ALERTS) pit[kind] = pit[kind].slice(-KEEP_ALERTS);
      noted[kind] = pit[kind].length;
    }
  }
  // M1: after any throw the in-memory pit may be half-way; go back to what is on disk. Never save it.
  function reload() {
    pit = readPit(); pit.pub_log ??= []; pit.stuck_since ??= null;
    store = readStore(); keys = new Set(store.keys); late = new Set(store.late ?? []);
    noted = { alerts: pit.alerts.length, flags: pit.flags.length };
  }
  function saveStore() { store.keys = [...keys]; store.late = [...late]; writeJson(P("pit-sends.json"), JSON.stringify(store, big)); }
  const armed = () => { try { return readFileSync(`${dir}/SEND`, "utf8").trim() === "on"; } catch { return false; } };
  const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

  async function sync() {
    const got = await pullSince(client, cfg.fire, { cursor: store.cursor, stopBeforeMs: cfg.startMs });
    let added = 0;
    for (const row of got.rows) {
      const st = readFireStaple(row, { fire: cfg.fire, baseText, koreText });
      if (!st) continue;
      for (const s of st.sends) {
        const k = `${s.block}:${s.op}`;
        if (keys.has(k)) continue;
        keys.add(k);
        const day = s.time.slice(0, 10);
        if (pit.closed[day] || pit.alloc[day]) {
          if (!late.has(k)) {
            late.add(k);
            // S1: late burns still go to pit-burns.csv; late KTA sends are kept with the amount for Bob.
            if (s.token !== "KTA") {
              pit.burns.push({ day_utc: day, block: s.block, op: s.op, from: s.from, token: s.token, amount_raw: s.amount, kind: s.token === "KORE" ? "burn_kore" : "burn_token", counts_for_mining: 0, test_mode: testMode ? "TEST" : "", late: 1 });
            } else {
              (store.lateSends ??= []).push({ day, key: k, from: s.from, amount_raw: s.amount, time: s.time });
            }
            pit.alerts.push([day, "LATE_SEND_AFTER_CLOSE", `${k} ${s.token} ${s.amount} from ${s.from}; not counted, Bob to review`]);
          }
          continue;
        }
        (store.byDay[day] ?? (store.byDay[day] = [])).push(s);
        added += 1;
      }
    }
    if (got.complete && got.rows.length) store.cursor = got.rows[0].voteStaple.blocksHash.toString();
    if (!got.complete) pit.alerts.push([utcDay(now()), "SYNC_INCOMPLETE", "fire history did not reach the cursor; no close this pass"]);
    saveStore(); save();
    return { complete: got.complete, added };
  }

  function blockTime(p) { const d = p?.date; return d instanceof Date ? d.getTime() : Date.parse(String(d ?? "")); }
  // "none", "live" (wait), "expired" (cannot land any more: same 6 min rule as run.mjs finishSignedBlock) or "stuck".
  async function pendingState() {
    const p = await client.pendingBlock?.();
    if (!p) { if (pit.stuck_since !== null) { pit.stuck_since = null; save(); } return "none"; }
    const at = blockTime(p);
    if (Number.isFinite(at)) {
      if (pit.stuck_since !== null) { pit.stuck_since = null; save(); }
      if (now() - at > EXPIRE_MS) { pit.alerts.push([utcDay(now()), "PENDING_EXPIRED", `pending block from ${new Date(at).toISOString()} has expired`]); return "expired"; }
      return "live";
    }
    if (pit.stuck_since === null) { pit.stuck_since = now(); save(); }
    if (now() - pit.stuck_since > STUCK_MS) { pit.alerts.push([utcDay(now()), "PENDING_STUCK", "pending block with no date for 30 min"]); return "stuck"; }
    return "live";
  }
  const pubEntry = (key) => pit.pub_log.find((e) => e.key === key);
  function voidOpen(key, it, why) {
    recover(pit, () => false);
    const e = pubEntry(key); if (e) e.fee = 0n;
    pit.alerts.push([it.day, "PAYOUT_VOID", `${key} ${why}; fee released, stays queued`]);
  }

  // Ops R-B1: settle the one open intent from the chain itself. The shaft's history is searched for the intent key; the
  // KORE balance is only a second witness. Void needs: complete history, key absent, balance says missed, no live pending
  // block, and 6 minutes gone. Anything else waits or holds.
  async function settle() {
    const open = Object.entries(pit.intents).filter(([, it]) => it.status === "intent");
    if (!open.length) return "none";
    if (open.length > 1) { hold("More than one open payout intent."); return "hold"; }
    const [key, it] = open[0];
    if (testMode) { voidOpen(key, it, "test-mode intent left open by a stop"); save(); return "void"; }
    const h = await findKeyedSends(client, ADDR.intake, { sinceMs: it.at - SETTLE_LOOKBACK_MS, koreText });
    const hits = h.sends.filter((s) => s.externals.includes(key));
    if (hits.length) {
      if (hits.length !== 1 || hits[0].to !== it.w || hits[0].amount !== it.amt) {
        pit.alerts.push([it.day, "PAYOUT_KEY_MISMATCH", `${key}: ${hits.length} sends on chain, to ${hits[0].to}, ${hits[0].amount} KORE`]);
        save(); hold(`On-chain send for ${key} does not match the intent.`); return "hold";
      }
      recover(pit, (k) => k === key); save();
      log(`Paid ${it.amt} KORE to ${it.w} (${key}), found on chain.`);
      return "paid";
    }
    const pend = await pendingState();
    if (pend === "stuck") { save(); hold("A pending block has no date and has not cleared in 30 min."); return "hold"; }
    if (pend === "live" || now() - it.at < EXPIRE_MS) return "wait";
    if (!h.complete) {
      pit.alerts.push([it.day, "PAYOUT_WAIT_HISTORY", `${key}: shaft history incomplete${h.broken ? ` (${h.broken})` : ""}; not voided`]);
      save(); hold(`Shaft history incomplete for ${key}.`); return "hold";
    }
    // Ops R-1 freshness gate: the walk's newest shaft block must be the head every representative reports. A rep that lags
    // or misses the paid row disagrees with the others (or with the walk), and a void then waits as a hold.
    const fresh = await headAgreed(client, ADDR.intake, h.head);
    if (!fresh.ok) {
      pit.alerts.push([it.day, "PAYOUT_WAIT_HISTORY", `${key}: shaft head not agreed (${fresh.why}); not voided`]);
      save(); hold(`Shaft head not agreed for ${key}.`); return "hold";
    }
    // Ops B-1 (3) and N-1: a shaft send to this wallet for exactly this amount whose external is not a readable kore- key
    // (base64, hex, missing) may be this payout. Hold, never void.
    const unkeyed = h.sends.filter((s) => s.to === it.w && s.amount === it.amt && !s.externals.some((e) => e.startsWith("kore-")));
    if (unkeyed.length) {
      pit.alerts.push([it.day, "PAYOUT_UNPROVEN", `${key}: ${unkeyed.length} shaft send(s) to ${it.w} for ${it.amt} KORE with no readable key; not voided`]);
      save(); hold(`A shaft send matching ${key} has no readable key.`); return "hold";
    }
    const verdict = judgeIntent(await client.balance(koreAccount), { floor: it.floor, amount: it.amt });
    if (verdict === "missed") {
      voidOpen(key, it, `not on chain after ${EXPIRE_MS / 60000} min (history searched)`); save();
      log(`KORE send did not land. Nothing marked paid. ${it.w} stays queued.`);
      return "void";
    }
    pit.alerts.push([it.day, "PAYOUT_UNPROVEN", `${key}: key not in shaft history but the balance says ${verdict}`]);
    save(); hold("KORE balance and shaft history disagree about the open payout."); return "hold";
  }

  async function publish(builder, quotes, cap) {
    const taken = { fee: 0n, used: false };
    const generateFeeBlock = async (staple) => {
      const q = quoteTotal(staple?.votes, baseText);
      if (!q.usable || q.foreign || q.amount > cap) throw new FeeStop(`vote fee ${q.amount} refused (cap ${cap})`);
      const block = await client.initBuilder().computeFeeBlock(staple);
      let sum = 0n;
      for (const op of block?.operations ?? []) {
        if (op?.type !== 0 && op?.type !== "SEND") continue;
        const tt = tokenText(op.token);
        if (tt && tt !== baseText) throw new FeeStop("fee block pays a token that is not KTA");
        sum += BigInt(op.amount ?? 0);
      }
      if (sum !== q.amount || sum > cap) throw new FeeStop(`fee block ${sum} does not match the vote fee ${q.amount}`);
      taken.fee = sum; taken.used = true;
      return block;
    };
    await client.publishBuilder(builder, { generateFeeBlock, quotes });
    return taken;
  }

  // Ops R-B2: the rolling-hour count and gap. Returns ms to wait, or 0.
  function rateWait(t) {
    const hour = pit.pub_log.filter((e) => e.ms > t - HOUR_MS);
    if (hour.length >= R.perHour) return Math.max(1, Math.min(...hour.map((e) => e.ms)) + HOUR_MS - t);
    const last = pit.pub_log.reduce((m, e) => Math.max(m, e.ms), 0);
    if (last && t - last < R.gapMs) return R.gapMs - Math.max(0, t - last);
    return 0;
  }
  // Fee room left this rolling hour and this wall-clock UTC day (both from the publish log).
  function feeRooms(t) {
    const hour = pit.pub_log.filter((e) => e.ms > t - HOUR_MS).reduce((a, e) => a + e.fee, 0n);
    const today = utcDay(t);
    const wall = pit.pub_log.filter((e) => utcDay(e.ms) === today).reduce((a, e) => a + e.fee, 0n);
    return { hour: R.hourFee - hour, wall: R.wallDayFee - wall };
  }
  let rateNoted = 0;

  // One close. "closed" when the day row is written; "wait" to try again next pass; "halt".
  // M1: nothing is written before the close either reaches a send (write-ahead) or ends; a throw leaves disk as it was.
  async function closeOne(day) {
    const sends = store.byDay[day] ?? [];
    const a = allocate(cfg, pit, day, sends, { testMode });
    if (a.halt) { save(); halt(`skipped close: unclosed days ${a.missing.join(", ")}`); return "halt"; }
    if (a.refused) { save(); return "closed"; }
    if (!a.resumed) log(`${T}Close ${day}: pot ${a.A.budget} KORE, ${a.A.rows.length} miners, ${a.A.burns.length} burns logged.`);
    if (existsSync(P("PAYHOLD"))) { save(); return "wait"; }
    if (Object.values(pit.intents).some((it) => it.status === "intent")) { save(); return "wait"; } // one open send at a time
    const q = startQueue(pit);
    pit.alloc[day].queued_at_start ??= q.due.length;
    let status = "paid";
    if (testMode) pit.fee_gross = await client.balance(base);
    for (;;) {
      const cand = queueNext(cfg, pit, day, q, { testMode });
      if (!cand) break;
      if (!testMode && !armed()) { status = "send_off"; break; }
      const t = now();
      const wait = rateWait(t);
      if (wait > 0) {
        if (t - rateNoted > 10 * 60_000) { rateNoted = t; log(`${T}Pace: next KORE send in ${Math.ceil(wait / 1000)} s (60 per hour, 3.0 KTA per hour).`); }
        save(); return "wait";
      }
      let fee = FEE_RAW; let builder = null; let quotes = null; let dest = null;
      if (!testMode) {
        try { dest = accountFrom(cand.w); } catch { pit.alerts.push([day, "BAD_ADDRESS", cand.w]); continue; }
        builder = client.initBuilder();
        builder.send(dest, cand.d, koreAccount, cand.key);
        const built = await builder.computeBlocks();
        quotes = await client.getQuotes(built.blocks);
        const qt = quoteTotal(quotes, baseText);
        if (!qt.usable || qt.foreign) { save(); warn(`${T}No usable KTA fee quote. Close ${day} retries.`); return "wait"; }
        fee = qt.amount;
        pit.fee_gross = await client.balance(base);
      }
      const judged = judgeFee(pit, day, fee);
      if (judged) { noteFeeStop(pit, day, cand, fee, judged); status = judged.stop; break; }
      const rooms = feeRooms(t);
      if (fee > rooms.wall) { pit.alerts.push([utcDay(t), "FEE_WALL_DAY_CAP", "0.5 KTA of fees spent this UTC day; the rest waits for the next close"]); status = "wall_day_cap"; break; }
      if (fee > rooms.hour) { save(); return "wait"; }
      if (testMode) { // modeled payouts only: nothing is published in test mode
        openIntent(pit, day, cand, fee); recordSend(pit, cand.key); applyPaid(pit, cand.key);
        pit.pub_log.push({ key: cand.key, ms: t, fee });
        save();
        continue;
      }
      const koreBal = await client.balance(koreAccount);
      const floor = floorAfter(koreBal, cand.d);
      if (floor === null) { save(); hold(`Vault short for ${cand.d} KORE.`); return "wait"; }
      const roomDay = DAY_CAP - (pit.fee_spent[day] ?? 0n);
      const roomReserve = pit.fee_gross === null ? STAPLE_CAP : pit.fee_gross - FEE_RESERVE;
      const cap = [STAPLE_CAP, roomDay, rooms.wall, rooms.hour, roomReserve].reduce((m, x) => (x < m ? x : m)); // Ops nb1
      const it = openIntent(pit, day, cand, fee);
      it.floor = floor; it.at = t;
      pit.pub_log.push({ key: cand.key, ms: t, fee });
      save(); // write-ahead: intent, fee reservation and publish log are on disk before the send
      let taken;
      try {
        taken = await publish(builder, quotes, cap);
      } catch (err) {
        // R-B1: no void here, not even for a FeeStop. settle() decides from the shaft history after the 6 min expiry.
        warn(`${T}KORE send failed: ${err instanceof Error ? err.message : "unknown"}. Settles from the shaft history.`);
        return "wait";
      }
      if (taken.used && taken.fee !== it.fee) { pit.fee_spent[day] += taken.fee - it.fee; it.fee = taken.fee; pubEntry(cand.key).fee = taken.fee; }
      save();
      const v = await settle();
      if (v !== "paid") return "wait";
    }
    if (pit.alloc[day] && !pit.closed[day]) {
      if (!testMode) pit.fee_gross = await client.balance(base);
      const out = finishClose(cfg, pit, day, pit.alloc[day], a.resumed, status, { testMode, queued: pit.alloc[day].queued_at_start });
      save();
      log(`${T}Closed ${day}: ${out.day.payouts_sent_modeled} payouts, status ${status}.`);
    }
    return "closed";
  }

  function outputs() {
    const today = utcDay(now());
    const v = publicViews(cfg, pit, { today, todaySends: store.byDay[today] ?? [], testMode, updated: new Date(now()).toISOString() });
    writeJson(P("pit-lookup.json"), JSON.stringify(v.lookup));
    writeJson(P("pit-ladder.json"), JSON.stringify(v.ladder));
    const stamp = (r) => ({ ...r, test_mode: testMode ? "TEST" : "" });
    writeJson(P("pit-days.csv"), csv(Object.values(pit.closed).map((r) => stamp(Object.fromEntries(Object.entries(r).map(([k, x]) => [k, String(x)]))))));
    writeJson(P("pit-burns.csv"), csv(pit.burns.map((b) => stamp(Object.fromEntries(Object.entries(b).map(([k, x]) => [k, String(x)]))))));
    if (!testMode) {
      try {
        mkdirSync(`${cfg.publicDir}/barter`, { recursive: true });
        copyFileSync(P("pit-lookup.json"), `${cfg.publicDir}/lookup.json`);
        copyFileSync(P("pit-ladder.json"), `${cfg.publicDir}/barter/ladder.json`);
      } catch { /* the page can wait */ }
    }
  }

  if (fresh) {
    save();
    try { renameSync(`${dir}/pit-init`, P("pit-init.used")); } catch (err) { refuse(`could not consume pit-init: ${err.message}`); }
    log(`${T}Pit state seeded from the ladder snapshot. Start ${new Date(cfg.startMs).toISOString()}. pit-init consumed.`);
  }
  // Startup: settle a send left open by a restart before anything else.
  await settle();
  log(`${T}Pit runner up. Fire ${cfg.fire}. Pit day 1 ${cfg.pitDay1}. ${testMode ? "TEST MODE: nothing is published." : armed() ? "KORE send is armed." : "KORE send is off."}`);
  let ran = 0;
  while (!stopped() && ran < steps) {
    ran += 1;
    try {
      const settled = await settle();
      const s = await sync();
      if (settled === "hold" || settled === "wait") log(`${T}A payout is still settling. No close this pass.`);
      else if (s.complete) {
        let day = pit.last_pit_closed ? nextDay(pit.last_pit_closed) : cfg.pitDay1;
        while (!stopped() && now() >= Date.parse(`${day}T00:00:00Z`) + DAY_MS + cfg.closeGraceMs) {
          const r = await closeOne(day);
          if (r !== "closed") break;
          day = nextDay(day);
        }
      }
      outputs();
    } catch (err) {
      warn(`${T}Retry. ${err instanceof Error ? err.message : "unknown"}`);
      try { reload(); } catch (e2) { warn(`${T}Could not reload the saved state: ${e2 instanceof Error ? e2.message : "unknown"}`); halt("state reload failed after an error"); }
    }
    if (ran < steps) await sleep(30_000);
  }
  log(`${T}Stopped.`);
}
