// Pace rule. Not the live runner.
// Spendable KTA is spread over the rest of the 24-hour window.
// More KTA raises the pace. The ceiling stops a big pile from being dumped at once.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const FEE_PER_TX = 120_000_000_000_000n; // 0.00012 KTA
export const BLOCK_TX = 50n;
export const BLOCK_FEE = FEE_PER_TX * BLOCK_TX; // 0.006 KTA
export const CEILING_MILLI = 17_000n; // 17.000 transfers a second
export const RESERVE = BLOCK_FEE;

export function kta(raw) {
  const whole = raw / 10n ** 18n;
  const frac = (raw < 0n ? -raw : raw) % 10n ** 18n;
  return `${whole}.${frac.toString().padStart(18, "0").slice(0, 5)}`;
}

export function fromKta(amount) {
  const [whole, frac = ""] = String(amount).split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0").slice(0, 18));
}

export function pace({ balance, remainingMs, reserve = RESERVE, feePerTx = FEE_PER_TX }) {
  const windowMs = remainingMs > 0 ? remainingMs : DAY_MS;
  const spendable = balance > reserve ? balance - reserve : 0n;
  const fee = feePerTx > 0n ? feePerTx : FEE_PER_TX;
  const transfers = spendable / fee;
  const milli = (transfers * 1_000_000n) / BigInt(windowMs);
  const capped = milli > CEILING_MILLI ? CEILING_MILLI : milli;
  const pack = choosePack({ spendable, feePerTx: fee });
  const intervalMs = capped === 0n || pack === 0 ? 0 : Number((BigInt(pack) * 1_000_000n) / capped);
  return { spendable, transfers, tpsMilli: capped, intervalMs, pack };
}

export function choosePack({ spendable, feePerTx = FEE_PER_TX, maxPack = BLOCK_TX }) {
  if (spendable <= 0n || feePerTx <= 0n || maxPack < 1n) return 0;
  const affordable = spendable / feePerTx;
  if (affordable >= maxPack) return Number(maxPack);
  if (affordable < 1n) return 0;
  return Number(affordable);
}

export function bundleCap() {
  const text = process.env.FEE_CAP_PER_BUNDLE_KTA;
  const raw = text === undefined || text === "" ? "0.05" : text;
  try {
    const cap = fromKta(raw);
    if (cap > 0n) return cap;
  } catch { /* fall through */ }
  return fromKta("0.05");
}

export class FeeOverCap extends Error {
  constructor(fee, cap) {
    super(`Fee ${fee.toString()} is over the ${cap.toString()} cap.`);
    this.name = "FeeOverCap";
    this.fee = fee;
    this.cap = cap;
  }
}

export function voteFeeTotal(staple) {
  let total = 0n;
  for (const vote of staple?.votes ?? []) {
    const fee = vote?.fee;
    if (fee === undefined || fee === null) continue;
    const fees = Array.isArray(fee) ? fee : [fee];
    for (const item of fees) {
      if (item?.amount === undefined || item?.amount === null) continue;
      total += BigInt(item.amount);
    }
  }
  return total;
}

export function judgeQuote({ quote, ops, spendable, feePerTx = FEE_PER_TX }) {
  if (quote <= 0n || ops <= 0n) return { ok: false, learn: feePerTx, reason: "empty" };
  const per = quote / ops;
  if (per <= 0n) return { ok: false, learn: feePerTx, reason: "empty" };
  if (quote > spendable) return { ok: false, learn: feePerTx, reason: "reserve" };
  if (quote > bundleCap()) return { ok: false, learn: feePerTx, reason: "cap" };
  return { ok: true, learn: per, reason: "ok" };
}

export function runWindow({ startBalance, addAt = [], nowMs = 0, publishMs = 0 }) {
  let balance = startBalance;
  let elapsed = 0;
  let transfers = 0;
  let blocks = 0;
  let peak = 0n;
  const marks = [];
  while (elapsed < DAY_MS) {
    for (const add of addAt) {
      if (!add.done && elapsed >= add.atMs) {
        balance += add.amount;
        add.done = true;
        marks.push({ atH: (elapsed / 3600000).toFixed(2), event: "deposit", balance: kta(balance) });
      }
    }
    const remaining = DAY_MS - elapsed;
    const plan = pace({ balance, remainingMs: remaining });
    if (plan.tpsMilli === 0n || plan.spendable < BLOCK_FEE) break;
    if (plan.tpsMilli > peak) peak = plan.tpsMilli;
    const wait = Math.max(plan.intervalMs, publishMs);
    if (elapsed + wait > DAY_MS && blocks > 0) break;
    balance -= BLOCK_FEE;
    transfers += Number(BLOCK_TX);
    blocks += 1;
    elapsed += wait;
  }
  const hours = elapsed / 3600000;
  const avgMilli = hours > 0 ? Math.round(transfers / (elapsed / 1000) * 1000) : 0;
  return { blocks, transfers, hours: hours.toFixed(2), avgTps: (avgMilli / 1000).toFixed(2), peakTps: (Number(peak) / 1000).toFixed(2), left: kta(balance), marks };
}

import { pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
function check(name, ok) {
  if (!ok) throw new Error(name);
  console.log("ok", name);
}

const day = pace({ balance: fromKta("30"), remainingMs: DAY_MS });
check("30 KTA is about 2.89/s", day.tpsMilli >= 2800n && day.tpsMilli <= 3000n);

const bigger = pace({ balance: fromKta("110"), remainingMs: DAY_MS });
check("110 KTA is about 10.6/s", bigger.tpsMilli >= 10400n && bigger.tpsMilli <= 10800n);
check("110 is faster than 30", bigger.tpsMilli > day.tpsMilli);

const huge = pace({ balance: fromKta("400"), remainingMs: DAY_MS });
check("400 KTA stops at 17/s", huge.tpsMilli === CEILING_MILLI);

const dust = pace({ balance: BLOCK_FEE, remainingMs: DAY_MS });
check("one block of fuel does not start a pace", dust.tpsMilli === 0n);

const slow = runWindow({ startBalance: fromKta("30") });
check("30 KTA lasts most of the day", Number(slow.hours) >= 23);
check("30 KTA stays under 3/s", Number(slow.peakTps) < 3);

const mid = runWindow({ startBalance: fromKta("110") });
check("110 KTA lasts most of the day", Number(mid.hours) >= 23);
check("110 KTA peaks near 10.6/s", Number(mid.peakTps) >= 10 && Number(mid.peakTps) <= 11);

const capped = runWindow({ startBalance: fromKta("400") });
check("400 KTA never passes 17/s", Number(capped.peakTps) <= 17);
check("400 KTA still has fuel after a day", fromKta(capped.left) > fromKta("200"));

const same = pace({ balance: fromKta("360"), remainingMs: DAY_MS, reserve: fromKta("2"), feePerTx: FEE_PER_TX });
check("today's fee still packs 50", same.pack === 50);
check("today's fee still hits the ceiling", same.tpsMilli === CEILING_MILLI);

const doubled = FEE_PER_TX * 2n;
const dear = pace({ balance: fromKta("362"), remainingMs: DAY_MS, reserve: fromKta("2"), feePerTx: doubled });
check("a doubled fee still packs 50", dear.pack === 50);
check("a doubled fee still hits the ceiling", dear.tpsMilli === CEILING_MILLI);

const costly = FEE_PER_TX * 10n;
const steep = pace({ balance: fromKta("362"), remainingMs: DAY_MS, reserve: fromKta("2"), feePerTx: costly });
check("a tenfold fee slows under the ceiling", steep.tpsMilli < CEILING_MILLI && steep.tpsMilli > 0n);
check("a tenfold fee still packs while it fits", steep.pack === 50);

const tight = choosePack({ spendable: FEE_PER_TX * 10n, feePerTx: FEE_PER_TX });
check("a thin balance packs only what it can pay", tight === 10);
check("dust does not pack a transfer", choosePack({ spendable: FEE_PER_TX - 1n }) === 0);

const spendable = fromKta("360");
const normal = judgeQuote({ quote: BLOCK_FEE, ops: BLOCK_TX, spendable, feePerTx: FEE_PER_TX });
check("today's quote is accepted", normal.ok && normal.learn === FEE_PER_TX);
const overCap = judgeQuote({ quote: BLOCK_FEE * 2n, ops: BLOCK_TX, spendable, feePerTx: FEE_PER_TX });
check("a fee the old cap would refuse is accepted", overCap.ok && overCap.learn === doubled);
const wild = judgeQuote({ quote: FEE_PER_TX * 100n * BLOCK_TX, ops: BLOCK_TX, spendable, feePerTx: FEE_PER_TX });
check("a wild quote is not paid", !wild.ok && wild.reason === "cap");
check("a wild quote does not raise the remembered fee", wild.learn === FEE_PER_TX);
const reserveHit = judgeQuote({ quote: fromKta("3"), ops: 1n, spendable: fromKta("2"), feePerTx: FEE_PER_TX });
check("a quote into the reserve is refused", !reserveHit.ok && reserveHit.reason === "reserve");
const oneSend = judgeQuote({ quote: FEE_PER_TX * 20n, ops: 1n, spendable, feePerTx: FEE_PER_TX * 20n });
check("a dispenser send above the old cap can fit", oneSend.ok);
const payout = judgeQuote({ quote: fromKta("0.00404"), ops: 1n, spendable, feePerTx: FEE_PER_TX });
check("a normal payout quote is under the cap", payout.ok && payout.reason === "ok");

const bumped = runWindow({
  startBalance: fromKta("30"),
  addAt: [{ atMs: 12 * 3600000, amount: fromKta("80"), done: false }],
});
check("a midday deposit raises the pace", Number(bumped.peakTps) > Number(slow.peakTps));

console.log("30 KTA", day.tpsMilli.toString(), "milli-tps", slow);
console.log("110 KTA", bigger.tpsMilli.toString(), "milli-tps", mid);
console.log("400 KTA", huge.tpsMilli.toString(), "milli-tps", capped);
console.log("30 then 80 at 12h", bumped);
}
