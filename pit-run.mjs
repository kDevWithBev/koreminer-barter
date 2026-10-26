// The pit runner (new model). Started by run.mjs main() when /opt/koreminer/pit-config.json exists.
// Watches the fire address, closes each UTC day in order, pays whole KORE oldest due first from the shaft.
// Money logic lives in pit.mjs (replayed against sim v5.1 by pit-check.mjs). This file is the chain and file plumbing.
//
// Files (all under dir, or dir/pit-test in test mode):
//   pit-config.json  (dir only)  {"pitDay1":"YYYY-MM-DD", "startTime"?: ISO, "test"?: bool, "ladderSeed": path, "ladderSeedMd5": hex,
//                                 "ladderLast"?: "YYYY-MM-DD", "closeGraceMs"?: ms, "publicDir"?: path}
//   pit-state.json   the whole pit (pit.mjs), written atomically after every step and before every send
//   pit-sends.json   every op seen to the fire address, by UTC day, plus the history cursor
//   pit-alerts.log   one line per new alert or flag
//   pit-days.csv / pit-burns.csv / pit-lookup.json / pit-ladder.json   outputs, rebuilt each pass
// Live only: SEND ("on" arms KORE sends), STOP, HALT, PAYHOLD in dir, same meaning as the legacy runner.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  ADDR, DAY_CAP, FEE_RAW, FROZEN, KTA_TOK, ONE_KTA, STAPLE_CAP, SUB, TEST_WALLETS,
  allocate, classify, createPit, finishClose, judgeFee, makeConfig, nextDay, noteFeeStop, openIntent,
  payable, pitFromJson, pitToJson, queueNext, recordSend, applyPaid, recover, startQueue, wholeDue, pct,
} from "./pit.mjs";
import { seedLadder, rungName, RUNGS } from "./ladder.mjs";
import { pullSince, readFireStaple } from "./chain.mjs";
import { floorAfter, judgeIntent } from "./pay.mjs";

export const EXPIRE_MS = 6 * 60 * 1000; // a signed block that has not landed in 6 minutes cannot gather votes
const DAY_MS = 86_400_000;

export class FeeStop extends Error {}

function writeJson(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}
const big = (k, v) => (typeof v === "bigint" ? `${v}n` : v);
const unbig = (k, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

export function readConfig(dir) {
  const path = `${dir}/pit-config.json`;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const cfg = makeConfig({ pitDay1: raw.pitDay1 });
  if (raw.startTime !== undefined) {
    const ms = Date.parse(raw.startTime);
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== cfg.pitDay1) throw new Error("startTime must be a time on pitDay1 (UTC)");
    cfg.startMs = ms;
  }
  if (raw.fire !== undefined && raw.fire !== cfg.fire) throw new Error("fire address in pit-config.json does not match the code");
  cfg.test = raw.test === true;
  cfg.ladderSeed = raw.ladderSeed;
  cfg.ladderSeedMd5 = raw.ladderSeedMd5;
  cfg.ladderLast = raw.ladderLast ?? new Date(Date.parse(`${cfg.pitDay1}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  cfg.closeGraceMs = Number(raw.closeGraceMs ?? 10 * 60 * 1000);
  cfg.publicDir = raw.publicDir ?? "/var/www/koreminer";
  if (!cfg.ladderSeed || !/^[0-9a-f]{32}$/.test(String(cfg.ladderSeedMd5 ?? ""))) throw new Error("ladderSeed and ladderSeedMd5 are required");
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
      const next = RUNGS.find(([n]) => n > lw.streak);
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
  const keys = Object.keys(rows[0]);
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
  log = console.log, warn = console.error,
} = {}) {
  const cfg = readConfig(dir);
  const testMode = cfg.test || testFlag;
  const sd = testMode ? `${dir}/pit-test` : dir;
  mkdirSync(sd, { recursive: true });
  const P = (n) => `${sd}/${n}`;
  const koreText = tokenText(koreAccount) || ADDR.kore;
  const T = testMode ? "TEST " : "";

  let pit;
  if (existsSync(P("pit-state.json"))) pit = pitFromJson(readFileSync(P("pit-state.json"), "utf8"));
  else { pit = freshPit(cfg); log(`${T}Pit state seeded from the ladder snapshot. Start ${new Date(cfg.startMs).toISOString()}.`); }
  let store = existsSync(P("pit-sends.json")) ? JSON.parse(readFileSync(P("pit-sends.json"), "utf8"), unbig) : { cursor: "", byDay: {}, keys: [] };
  const keys = new Set(store.keys);
  let noted = { alerts: pit.alerts.length, flags: pit.flags.length };
  const late = new Set(store.late ?? []);

  function save() {
    writeJson(P("pit-state.json"), pitToJson(pit));
    for (const [list, kind] of [[pit.alerts, "alerts"], [pit.flags, "flags"]]) {
      for (const a of list.slice(noted[kind])) {
        const line = `${new Date(now()).toISOString()} ${T}${a.join(" ")}`;
        appendFileSync(P("pit-alerts.log"), `${line}\n`);
        warn(line);
      }
      noted[kind] = list.length;
    }
  }
  function saveStore() { store.keys = [...keys]; store.late = [...late]; writeJson(P("pit-sends.json"), JSON.stringify(store, big)); }
  const armed = () => { try { return readFileSync(`${dir}/SEND`, "utf8").trim() === "on"; } catch { return false; } };
  function hold(reason) { writeFileSync(`${dir}/PAYHOLD`, `${reason}\n`); warn(`${T}KORE sends wait. ${reason}`); }
  function halt(reason) { writeFileSync(`${dir}/HALT`, `${reason}\n`); warn(`${T}HALT. ${reason}`); }

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
          if (!late.has(k)) { late.add(k); pit.alerts.push([day, "LATE_SEND_AFTER_CLOSE", `${k} from ${s.from}; not counted, Bob to review`]); }
          continue;
        }
        (store.byDay[day] ?? (store.byDay[day] = [])).push(s);
        added += 1;
      }
    }
    if (got.complete && got.rows.length) store.cursor = got.rows[0].voteStaple.blocksHash.toString();
    if (!got.complete) pit.alerts.push([new Date(now()).toISOString().slice(0, 10), "SYNC_INCOMPLETE", "fire history did not reach the cursor; no close this pass"]);
    saveStore(); save();
    return { complete: got.complete, added };
  }

  // Settle the one open intent from the KORE balance (same floor rule as the legacy runner).
  async function settle() {
    const open = Object.entries(pit.intents).filter(([, it]) => it.status === "intent");
    if (!open.length) return "none";
    if (open.length > 1) { hold("More than one open payout intent."); return "hold"; }
    const [key, it] = open[0];
    if (testMode) { recover(pit, () => false); save(); return "void"; }
    const bal = await client.balance(koreAccount);
    const verdict = judgeIntent(bal, { floor: it.floor, amount: it.amt });
    if (verdict === "paid") {
      recover(pit, (k) => k === key); save();
      log(`Paid ${it.amt} KORE to ${it.w} (${key}).`);
      return "paid";
    }
    if (verdict === "missed") {
      const pending = await client.pendingBlock?.();
      if (now() - it.at < EXPIRE_MS || pending) return "wait";
      recover(pit, () => false);
      pit.alerts.push([it.day, "PAYOUT_VOID", `${key} not on chain after ${EXPIRE_MS / 60000} min; fee released, stays queued`]);
      save();
      log(`KORE send did not land. Nothing marked paid. ${it.w} stays queued.`);
      return "void";
    }
    hold("KORE balance does not match the open payout."); return "hold";
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

  // One close. "closed" when the day row is written; "wait" to try again next pass; "halt".
  async function closeOne(day) {
    const sends = store.byDay[day] ?? [];
    const a = allocate(cfg, pit, day, sends, { testMode });
    if (a.halt) { save(); halt(`skipped close: unclosed days ${a.missing.join(", ")}`); return "halt"; }
    if (a.refused) { save(); return "closed"; }
    save();
    if (!a.resumed) log(`${T}Close ${day}: pot ${a.A.budget} KORE, ${a.A.rows.length} miners, ${a.A.burns.length} burns logged.`);
    if (!testMode && existsSync(`${dir}/PAYHOLD`)) return "wait";
    if (Object.values(pit.intents).some((it) => it.status === "intent")) return "wait"; // one open send at a time
    const q = startQueue(pit);
    const queued = q.due.length;
    let status = "paid";
    if (testMode) pit.fee_gross = await client.balance(base);
    for (;;) {
      const cand = queueNext(cfg, pit, day, q, { testMode });
      if (!cand) break;
      if (testMode) { // modeled payouts only: nothing is published in test mode
        const judged = judgeFee(pit, day, FEE_RAW);
        if (judged) { noteFeeStop(pit, day, cand, FEE_RAW, judged); status = judged.stop; break; }
        openIntent(pit, day, cand, FEE_RAW); recordSend(pit, cand.key); applyPaid(pit, cand.key); save();
        continue;
      }
      if (!armed()) { status = "send_off"; break; }
      let dest;
      try { dest = accountFrom(cand.w); } catch { pit.alerts.push([day, "BAD_ADDRESS", cand.w]); continue; }
      const builder = client.initBuilder();
      builder.send(dest, cand.d, koreAccount, cand.key);
      const built = await builder.computeBlocks();
      const quotes = await client.getQuotes(built.blocks);
      const qt = quoteTotal(quotes, baseText);
      if (!qt.usable || qt.foreign) { save(); warn(`${T}No usable KTA fee quote. Close ${day} retries.`); return "wait"; }
      pit.fee_gross = await client.balance(base);
      const judged = judgeFee(pit, day, qt.amount);
      if (judged) { noteFeeStop(pit, day, cand, qt.amount, judged); status = judged.stop; break; }
      const koreBal = await client.balance(koreAccount);
      const floor = floorAfter(koreBal, cand.d);
      if (floor === null) { save(); hold(`Vault short for ${cand.d} KORE.`); return "wait"; }
      const it = openIntent(pit, day, cand, qt.amount);
      it.floor = floor; it.at = now();
      save(); // write-ahead: intent + fee reservation are on disk before the send
      const spentBefore = (pit.fee_spent[day] ?? 0n) - qt.amount;
      const room = DAY_CAP - spentBefore;
      let taken;
      try {
        taken = await publish(builder, quotes, room < STAPLE_CAP ? room : STAPLE_CAP);
      } catch (err) {
        if (err instanceof FeeStop && !(await client.pendingBlock?.())) { recover(pit, () => false); save(); warn(`${T}${err.message}. Close ${day} retries.`); return "wait"; }
        warn(`${T}KORE send failed: ${err instanceof Error ? err.message : "unknown"}. Settles from the balance.`);
        return "wait";
      }
      if (taken.used && taken.fee !== it.fee) { pit.fee_spent[day] += taken.fee - it.fee; it.fee = taken.fee; }
      save();
      const v = await settle();
      if (v !== "paid") return "wait";
    }
    if (pit.alloc[day] && !pit.closed[day]) {
      if (!testMode) pit.fee_gross = await client.balance(base);
      const out = finishClose(cfg, pit, day, pit.alloc[day], a.resumed, status, { testMode, queued });
      save();
      log(`${T}Closed ${day}: ${out.day.payouts_sent_modeled} payouts, status ${status}.`);
    }
    return "closed";
  }

  function outputs() {
    const today = new Date(now()).toISOString().slice(0, 10);
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

  // Startup: settle a send left open by a restart before anything else.
  await settle();
  log(`${T}Pit runner up. Fire ${cfg.fire}. Pit day 1 ${cfg.pitDay1}. ${testMode ? "TEST MODE: nothing is published." : armed() ? "KORE send is armed." : "KORE send is off."}`);
  let ran = 0;
  while (!existsSync(`${dir}/STOP`) && !existsSync(`${dir}/HALT`) && ran < steps) {
    ran += 1;
    try {
      const settled = await settle();
      const s = await sync();
      if (settled === "hold" || settled === "wait") log(`${T}A payout is still settling. No close this pass.`);
      else if (s.complete) {
        let day = pit.last_pit_closed ? nextDay(pit.last_pit_closed) : cfg.pitDay1;
        while (now() >= Date.parse(`${day}T00:00:00Z`) + DAY_MS + cfg.closeGraceMs) {
          const r = await closeOne(day);
          if (r !== "closed") break;
          day = nextDay(day);
        }
      }
      outputs();
    } catch (err) {
      warn(`${T}Retry. ${err instanceof Error ? err.message : "unknown"}`);
      try { save(); } catch { /* keep the last good state */ }
    }
    if (ran < steps) await sleep(30_000);
  }
  log(`${T}Stopped.`);
}
