import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, unlinkSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BLOCK_FEE, DAY_MS, FEE_PER_TX, FeeOverCap, blocksInHour, bundleCap, configLine, judgeQuote, kta, maxBlocksPerHour, minPublishGapMs, pace, payoutFeeBudget, payoutFeeCap, picksOff, pruneRecent } from "./pace.mjs";
import { RESERVE, accrue, due } from "./share.mjs";
import { dayStart } from "./ledger.mjs";
import { booksFromJson, booksToJson, ingest, notePublished, payoutPlan, publicBooks, reconcile } from "./books.mjs";
import { pullNew, readStaple } from "./chain.mjs";
import { applyPaid, choosePayout, floorAfter, judgeIntent } from "./pay.mjs";
import { applyClaimFile } from "./claim.mjs";
import { creditStaples } from "./base-credit.mjs";
import { applyLinks, readLinks } from "./links.mjs";

const intake =
  "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const kore =
  "keeta_apu6efya45r6rirjwyhl25djcuqg53zlepwctj7xpzvmrhfwckrzxwht4sypk";
const sink =
  "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const defaultDir = "/opt/koreminer";
const publicLookup = "/var/www/koreminer/lookup.json";

function isOverCap(err) {
  return err instanceof FeeOverCap || err?.name === "FeeOverCap";
}

class FeeUnusable extends Error {
  constructor() {
    super("No usable fee.");
    this.name = "FeeUnusable";
  }
}

function isUnusable(err) {
  return err instanceof FeeUnusable || err?.name === "FeeUnusable";
}

function readFeeAmount(item) {
  if (item == null || typeof item !== "object") return null;
  if (item.amount === undefined || item.amount === null || item.amount === "") return null;
  try {
    return BigInt(item.amount);
  } catch {
    return null;
  }
}

function isBigintZero(item) {
  return !!item && typeof item === "object" && typeof item.amount === "bigint" && item.amount === 0n;
}

function feeTokenText(token) {
  if (typeof token === "string") return token;
  if (typeof token?.id === "string") return token.id;
  const key = token?.publicKeyString;
  if (typeof key?.toString === "function") {
    const text = key.toString();
    if (text && text !== "[object Object]") return text;
  }
  if (typeof key?.get === "function") {
    const text = key.get();
    if (typeof text === "string") return text;
  }
  return "";
}

function tokenIsKta(token, base, baseText) {
  if (token === undefined || token === null || token === "") return true;
  if (typeof token?.comparePublicKey === "function") return token.comparePublicKey(base) === true;
  if (base !== undefined && token === base) return true;
  const text = feeTokenText(token);
  if (!text) return false;
  if (baseText && text === baseText) return true;
  if (base?.id && text === base.id) return true;
  const baseKey = base?.publicKeyString;
  if (typeof baseKey?.toString === "function" && text === baseKey.toString()) return true;
  return false;
}

function addressOf(value) {
  if (value === undefined || value === null || value === "") return "none";
  if (typeof value === "string") return value;
  const text = feeTokenText(value);
  return text || "none";
}

function formatFeeOptions(entries) {
  const list = entries ?? [];
  if (list.length === 0) return "none, none, none";
  return list.map((entry) => {
    const fee = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "fee") ? entry.fee : entry;
    if (fee === undefined || fee === null) return "none, none, none";
    const fees = Array.isArray(fee) ? fee : [fee];
    if (fees.length === 0) return "none, none, none";
    return fees.map((item) => {
      const amount = readFeeAmount(item);
      const amountText = amount === null ? "none" : kta(amount);
      return `${amountText}, ${addressOf(item?.token)}, ${addressOf(item?.payTo)}`;
    }).join("; ");
  }).join(" | ");
}

// One option per vote. Only a bigint 0n makes the vote free. A string "0" does not.
export function selectFee(feeOrList, ctx = {}) {
  const { base, baseText } = ctx;
  if (feeOrList === undefined || feeOrList === null) return { kind: "none", amount: 0n };
  const fees = Array.isArray(feeOrList) ? feeOrList : [feeOrList];
  if (fees.length === 0) return { kind: "none", amount: 0n };
  for (const item of fees) {
    if (isBigintZero(item)) return { kind: "free", amount: 0n };
  }
  for (const item of fees) {
    const amount = readFeeAmount(item);
    if (amount === null) continue;
    if (tokenIsKta(item?.token, base, baseText)) return { kind: "kta", amount };
  }
  return { kind: "foreign", amount: readFeeAmount(fees[0]) ?? 0n };
}

function nonKtaError(fee, cap) {
  const err = new FeeOverCap(fee ?? 0n, cap);
  err.nonKta = true;
  return err;
}

export async function runShaft({
  dir = defaultDir,
  client,
  base,
  baseText,
  dustAccount,
  koreAccount,
  accountFrom,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  steps = Infinity,
  koreStart: koreStartIn = null,
} = {}) {
  const statePath = `${dir}/state.json`;
  const booksPath = `${dir}/books.json`;
  const planPath = `${dir}/payout-plan.json`;
  const intentPath = `${dir}/payout-intent.json`;
  const floorPath = `${dir}/kore-floor.txt`;
  const lookupPath = `${dir}/lookup.json`;
  const linksPath = `${dir}/links.json`;
  const closeAccrue = process.env.CLOSE_ACCRUE === "1";
  let chainRetry = false;
  let closeCreditGaveUp = false;
  let closeCreditWaitAt = null;

  let overCapStep = null;
  let refusedFeesNoted = false;
  let payoutBlockNoted = "";
  const leftPickNoted = new Set();

  function sayPublished(ok, paceMilli, fee, spent, left, elapsed) {
    console.log(
      "Published",
      ok,
      "pace",
      (Number(paceMilli) / 1000).toFixed(2),
      "fee",
      kta(fee),
      "KTA",
      "spent",
      kta(spent),
      "KTA",
      "left",
      kta(left),
      "cycle",
      (elapsed / 1000).toFixed(1),
      "s",
    );
  }

  function armEpisode(err) {
    const first = overCapStep === null;
    if (first) {
      overCapStep = 0;
      const fee = err?.fee ?? 0n;
      const cap = err?.cap ?? bundleCap();
      if (err?.nonKta) console.error("ALERT Non-KTA fee selected. Backing off.");
      else console.error(`ALERT Fee ${kta(fee)} KTA is over the ${kta(cap)} KTA cap. Backing off.`);
    }
    const delay = Math.min(30_000 * 2 ** overCapStep, 600_000);
    overCapStep += 1;
    return delay;
  }

  function clearEpisode() {
    overCapStep = null;
    refusedFeesNoted = false;
  }

  function rateWait() {
    const last = Number(state.lastPublishMs) || 0;
    if (!last) return 0;
    const at = now();
    if (last > at) {
      state.lastPublishMs = at;
      writeState(state);
    }
    const gap = minPublishGapMs();
    const elapsed = at - Number(state.lastPublishMs);
    return elapsed >= gap ? 0 : gap - elapsed;
  }

  async function pauseForRate() {
    const wait = rateWait();
    if (wait > 0) await sleep(wait);
  }

  function notePublish() {
    state.lastPublishMs = now();
    writeState(state);
  }

  // Holds. FEEHOLD pauses picks (payouts keep their own cap and budget). RATEHOLD pauses every publish.
  // Only a person removes them. A trip only pauses; it never sends anything back.
  const statusPath = `${dir}/status.json`;
  const feeHoldPath = `${dir}/FEEHOLD`;
  const rateHoldPath = `${dir}/RATEHOLD`;
  let feeChecked = false;
  let feeSkipNoted = "";
  let feeSkipAt = null;
  let feeRetryAt = 0;
  let pausedNoted = "";
  let pausedNotedAt = null;
  let lastStatus = (() => {
    try {
      const saved = JSON.parse(readFileSync(statusPath, "utf8"));
      return typeof saved.state === "string" && typeof saved.reason === "string" ? `${saved.state}|${saved.reason}` : "";
    } catch {
      return "";
    }
  })();
  let statusWritten = false; // first write per process is unconditional, so status.json mtime proves this start
  let statusSince = 0;
  let statusBlocks = -1;

  function holdReason(path) {
    try {
      const text = readFileSync(path, "utf8").split("\n")[0].replace(/[^ -~]/g, "").slice(0, 200);
      return text || "no reason given";
    } catch {
      return "unreadable";
    }
  }

  function writeStatus(name, reason) {
    const key = `${name}|${reason}`;
    if (key === lastStatus && statusWritten) return;
    statusWritten = true;
    if (lastStatus.startsWith("paused|") && name === "running") console.log("Resumed.");
    lastStatus = key;
    statusSince = now();
    putStatus(name, reason);
  }

  function putStatus(name, reason) {
    const at = now();
    statusBlocks = blocksInHour(state.recent, at);
    try {
      writeJson(statusPath, { state: name, reason, since: new Date(statusSince).toISOString(), blocksLastHour: statusBlocks, limit: maxBlocksPerHour() });
    } catch { /* the runner goes on; the hold file and the journal line still stand */ }
  }

  // Same state and reason, but the rolling count moved: rewrite the count (and keep "since").
  function refreshStatus() {
    if (!statusWritten) return;
    if (blocksInHour(state.recent, now()) === statusBlocks) return;
    const cut = lastStatus.indexOf("|");
    putStatus(lastStatus.slice(0, cut), lastStatus.slice(cut + 1));
  }

  function notePaused(reason, tail) {
    const at = now();
    if (reason === pausedNoted && pausedNotedAt !== null && at - pausedNotedAt < 10 * 60 * 1000) return;
    pausedNoted = reason;
    pausedNotedAt = at;
    console.log(`Paused: ${reason}. ${tail}`);
  }

  function picksPaused() {
    return picksOff() || existsSync(feeHoldPath);
  }

  function tripFee(fee, nonKta) {
    feeChecked = false;
    const what = nonKta ? "a non-KTA fee was quoted" : `fee ${kta(fee)} KTA a block is over the ${kta(bundleCap())} KTA cap`;
    if (!existsSync(feeHoldPath)) {
      writeFileSync(feeHoldPath, `${what} at ${new Date(now()).toISOString()}. Ask Keeta before removing this file.\n`);
      console.error(`ALERT ${nonKta ? "Non-KTA fee selected" : `Fee ${kta(fee)} KTA is over the ${kta(bundleCap())} KTA cap`}. Picks paused (FEEHOLD). Ask Keeta before removing FEEHOLD.`);
    }
    writeStatus("paused", `FEEHOLD: ${holdReason(feeHoldPath)}`);
  }

  function tripRate(used, n, limit, what) {
    const reason = `${used} ledger blocks in the last hour, the next ${what} (${n}) would pass the ${limit} an hour cap, at ${new Date(now()).toISOString()}`;
    writeFileSync(rateHoldPath, `${reason}. Remove this file only after review.\n`);
    console.error(`ALERT Rate cap: ${used} ledger blocks in the last hour, the next ${what} would pass ${limit}. All publishing paused (RATEHOLD). Remove RATEHOLD only after review.`);
    writeStatus("paused", `RATEHOLD: ${holdReason(rateHoldPath)}`);
  }

  // Hard rolling-hour count of ledger blocks, taken before every publish and saved first,
  // so a publish whose result is unknown still counts.
  function takeBlocks(n, what) {
    if (existsSync(rateHoldPath)) return false;
    const at = now();
    state.recent = pruneRecent(state.recent, at);
    const used = blocksInHour(state.recent, at);
    const limit = maxBlocksPerHour();
    if (used + n > limit) {
      tripRate(used, n, limit, what);
      return false;
    }
    state.recent.push([at, n]);
    state.lastPublishMs = at; // space from the attempt, so an unknown-result publish keeps the 120 s gap
    writeState(state);
    refreshStatus();
    return true;
  }

  function feeSum(quote) {
    const picked = selectFee(quote?.fee, { base, baseText });
    if (picked.kind === "foreign") return { kta: 0n, foreign: picked.amount, refused: true, usable: true };
    if (picked.kind === "kta") return { kta: picked.amount, foreign: 0n, refused: false, usable: true };
    if (picked.kind === "free") return { kta: 0n, foreign: 0n, refused: false, usable: true };
    return { kta: 0n, foreign: 0n, refused: false, usable: false };
  }

  function quotesFee(quotes) {
    if (quotes == null) return { amount: 0n, foreign: false, shown: 0n, usable: true };
    if (quotes.length === 0) return { amount: 0n, foreign: false, shown: 0n, usable: false };
    let ktaFee = 0n;
    let foreign = 0n;
    let refused = false;
    let usable = false;
    for (const quote of quotes) {
      const part = feeSum(quote);
      ktaFee += part.kta;
      foreign += part.foreign;
      if (part.refused) refused = true;
      if (part.usable) usable = true;
    }
    return { amount: ktaFee, foreign: refused, shown: refused ? ktaFee + foreign : ktaFee, usable };
  }

  function noteRefusedFees(entries) {
    if (refusedFeesNoted || overCapStep !== null) return;
    refusedFeesNoted = true;
    console.error(`Refused fee options: ${formatFeeOptions(entries)}`);
  }

  function sendTotals(block) {
    let total = 0n;
    let foreign = false;
    let foreignAmount = 0n;
    const ops = Array.isArray(block?.operations) ? block.operations : [];
    for (const op of ops) {
      const type = op?.type;
      if (type !== 0 && type !== "SEND") continue;
      let amount = 0n;
      try {
        if (op?.amount !== undefined && op?.amount !== null && op?.amount !== "") amount = BigInt(op.amount);
      } catch {
        amount = 0n;
      }
      if (!tokenIsKta(op?.token, base, baseText)) {
        foreign = true;
        foreignAmount += amount;
        continue;
      }
      total += amount;
    }
    return { total, foreign, foreignAmount };
  }

  function assertBuiltFee(block, ktaFee, cap, votes) {
    const built = sendTotals(block);
    if (built.foreign) {
      noteRefusedFees(votes);
      throw nonKtaError(built.foreignAmount, cap);
    }
    if (built.total > cap || built.total !== ktaFee) {
      noteRefusedFees(votes);
      throw new FeeOverCap(built.total, cap);
    }
  }

  function cappedFeeBlock(cap) {
    // 0n is a real cap (the day's payout room is gone). Never replace it with the bundle default.
    if (cap === undefined) cap = bundleCap();
    const taken = { fee: 0n, used: false };
    const generateFeeBlock = async (staple) => {
      const votes = staple?.votes ?? [];
      if (votes.length === 0) {
        noteRefusedFees(votes);
        throw new FeeUnusable();
      }
      let ktaFee = 0n;
      let foreignFee = 0n;
      let foreign = false;
      let usable = false;
      for (const vote of votes) {
        const picked = selectFee(vote?.fee, { base, baseText });
        if (picked.kind === "none") continue;
        usable = true;
        if (picked.kind === "free") continue;
        if (picked.kind === "foreign") {
          foreign = true;
          foreignFee += picked.amount;
          continue;
        }
        ktaFee += picked.amount;
      }
      if (!usable) {
        noteRefusedFees(votes);
        throw new FeeUnusable();
      }
      if (foreign) {
        noteRefusedFees(votes);
        throw nonKtaError(foreignFee, cap);
      }
      if (ktaFee > cap) {
        noteRefusedFees(votes);
        throw new FeeOverCap(ktaFee, cap);
      }
      const builder = client.initBuilder();
      const block = await builder.computeFeeBlock(staple);
      assertBuiltFee(block, ktaFee, cap, votes);
      taken.fee = ktaFee;
      taken.used = true;
      return block;
    };
    return { generateFeeBlock, taken };
  }

  async function publishCapped(builder, quotes, cap) {
    // 0n is a real cap. A default parameter would be safe in JS, but do not treat 0n as missing.
    if (cap === undefined) cap = bundleCap();
    const quoted = quotesFee(quotes);
    if (quotes != null && quoted.foreign) {
      noteRefusedFees(quotes);
      throw nonKtaError(quoted.shown, cap);
    }
    if (quotes != null && !quoted.usable) {
      noteRefusedFees(quotes);
      throw new FeeUnusable();
    }
    if (quoted.amount > cap) {
      noteRefusedFees(quotes);
      throw new FeeOverCap(quoted.amount, cap);
    }
    const { generateFeeBlock, taken } = cappedFeeBlock(cap);
    const result = await client.publishBuilder(builder, { generateFeeBlock, quotes });
    return { result, fee: taken.used ? taken.fee : 0n };
  }

  function clampFeePerTx(value) {
    let fee = FEE_PER_TX;
    try { fee = BigInt(value ?? FEE_PER_TX); } catch { return FEE_PER_TX; }
    if (fee <= 0n || fee > bundleCap() / 50n) return FEE_PER_TX;
    return fee;
  }

  function clampPayoutSpent(value) {
    try {
      const spent = BigInt(value ?? "0");
      if (spent < 0n) return 0n;
      return spent;
    } catch {
      return 0n;
    }
  }

  function readState() {
    try {
      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      return {
        windowStart: Number(saved.windowStart) || now(),
        spent: BigInt(saved.spent ?? "0"),
        feePerTx: clampFeePerTx(saved.feePerTx ?? FEE_PER_TX.toString()),
        payoutDay: typeof saved.payoutDay === "string" ? saved.payoutDay : "",
        done: Array.isArray(saved.done) ? saved.done.filter((item) => typeof item === "string") : [],
        closeOpen: saved.closeOpen === true,
        lastPublishMs: Number(saved.lastPublishMs) || 0,
        payoutFeeDay: typeof saved.payoutFeeDay === "string" ? saved.payoutFeeDay : "",
        payoutFeeSpent: clampPayoutSpent(saved.payoutFeeSpent),
        recent: pruneRecent(saved.recent, now()),
      };
    } catch {
      // A state.json that exists but can't be read loses the rolling count: fail safe into RATEHOLD
      // (kept copy in state.json.bad) instead of starting the count again from 0. A missing file is a first start.
      if (existsSync(statePath)) {
        try { copyFileSync(statePath, `${statePath}.bad`); } catch { /* the hold still stands */ }
        if (!existsSync(rateHoldPath)) {
          writeFileSync(rateHoldPath, `state.json unreadable at ${new Date(now()).toISOString()}, so the rolling hour count is unknown (copy in state.json.bad). Remove this file only after review.\n`);
          console.error("ALERT state.json is unreadable, so the rolling hour count is unknown. All publishing paused (RATEHOLD). Remove RATEHOLD only after review.");
        }
      }
      return { windowStart: now(), spent: 0n, feePerTx: FEE_PER_TX, payoutDay: "", done: [], closeOpen: false, lastPublishMs: 0, payoutFeeDay: "", payoutFeeSpent: 0n, recent: [] };
    }
  }

  function writeJson(path, value) {
    const body = JSON.stringify(value);
    writeFileSync(`${path}.tmp`, body);
    renameSync(`${path}.tmp`, path);
  }

  function loadBooks() {
    try {
      return booksFromJson(JSON.parse(readFileSync(booksPath, "utf8")));
    } catch {
      console.error("Stop. Books are not open. Nothing was sent.");
      process.exit(1);
    }
  }

  function saveBooks(books) {
    const sending = sendArmed();
    writeJson(booksPath, booksToJson(books));
    const view = publicBooks(books, sending);
    writeJson(lookupPath, view);
    try { copyFileSync(lookupPath, publicLookup); } catch { /* the page can wait */ }
    writeJson(planPath, payoutPlan(books, sending));
  }

  function sendArmed() {
    try {
      return readFileSync(`${dir}/SEND`, "utf8").trim() === "on";
    } catch {
      return false;
    }
  }

  function readIntent() {
    try {
      return JSON.parse(readFileSync(intentPath, "utf8"));
    } catch {
      return null;
    }
  }

  function clearIntent() {
    try { unlinkSync(intentPath); } catch { /* none */ }
  }

  function clearFloor(floor) {
    if (recordedKoreFloor() !== floor) return;
    try { unlinkSync(floorPath); } catch { /* none */ }
  }

  async function syncChain(books) {
    chainRetry = false;
    const rows = await pullNew(client, books.cursor);
    const staples = [];
    for (const row of rows) {
      const staple = readStaple(row, baseText);
      if (staple) staples.push(staple);
    }
    staples.sort((a, b) => a.timeMs - b.timeMs);
    const newest = rows.length > 0 ? rows[0].voteStaple.blocksHash.toString() : "";
    const named = await creditStaples(books, staples, {
      newest,
      links: readLinks(linksPath),
      ingest: ingestSafe,
      now: now(),
    });
    if (named === "halt-reserve") return "halt-reserve";
    if (named === "retry") {
      chainRetry = true;
      return books.share.lastMs;
    }
    const chainMs = staples.reduce((max, staple) => Math.max(max, staple.timeMs), books.share.lastMs);
    return chainMs;
  }

  function ingestSafe(books, staple) {
    return ingest(books, staple);
  }

  function writeState(state) {
    const body = JSON.stringify({
      windowStart: state.windowStart,
      spent: state.spent.toString(),
      feePerTx: (state.feePerTx ?? FEE_PER_TX).toString(),
      payoutDay: state.payoutDay ?? "",
      done: state.done ?? [],
      closeOpen: state.closeOpen === true,
      lastPublishMs: state.lastPublishMs || 0,
      payoutFeeDay: state.payoutFeeDay ?? "",
      payoutFeeSpent: (state.payoutFeeSpent ?? 0n).toString(),
      recent: Array.isArray(state.recent) ? state.recent : [],
    });
    writeFileSync(`${statePath}.tmp`, body);
    renameSync(`${statePath}.tmp`, statePath);
  }

  function rollPayoutFeeDay() {
    const today = new Date(now()).toISOString().slice(0, 10);
    state.payoutFeeSpent = clampPayoutSpent(state.payoutFeeSpent);
    if (state.payoutFeeDay === today) return;
    state.payoutFeeDay = today;
    state.payoutFeeSpent = 0n;
    writeState(state);
  }

  function recordedKoreFloor() {
    try {
      const text = readFileSync(floorPath, "utf8").trim();
      if (!/^[0-9]+$/.test(text)) return null;
      return BigInt(text);
    } catch {
      return null;
    }
  }

  let state = readState();
  rollPayoutFeeDay();
  const books = loadBooks();
  writeState(state);
  let blockNo = 0;
  let koreStart = koreStartIn === null ? await client.balance(kore) : koreStartIn;

  function blockTime(pending) {
    const when = pending.date instanceof Date ? pending.date.getTime() : Date.parse(String(pending.date));
    return when;
  }

  function pendingBlocksOf(pending) {
    if (Array.isArray(pending?.blocks)) return pending.blocks;
    if (Array.isArray(pending?.operations)) return [pending];
    return [];
  }

  function pendingOperations(pending) {
    const ops = [];
    for (const block of pendingBlocksOf(pending)) {
      for (const op of Array.isArray(block?.operations) ? block.operations : []) ops.push(op);
    }
    return ops;
  }

  function accountKey(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "string") return value;
    const key = value.publicKeyString;
    if (key && typeof key.get === "function") {
      try {
        const text = key.get();
        if (typeof text === "string" && text) return text;
      } catch { /* the string form is next */ }
    }
    if (key && typeof key.toString === "function") {
      const text = key.toString();
      if (typeof text === "string" && text && text !== "[object Object]") return text;
    }
    if (typeof value.id === "string" && value.id) return value.id;
    return "";
  }

  function isKoreSendToken(token) {
    const text = accountKey(token);
    if (!text) return false;
    const koreText = accountKey(koreAccount);
    if (koreText && text === koreText) return true;
    return text === kore;
  }

  function hashText(hash) {
    if (typeof hash === "string" && hash) return hash;
    if (hash && typeof hash.toString === "function") {
      const text = hash.toString();
      if (typeof text === "string" && text && text !== "[object Object]") return text;
    }
    return "";
  }

  function isPendingPayout(pending) {
    const intent = readIntent();
    if (!intent || typeof intent.from !== "string" || typeof intent.key !== "string") return false;
    let owed = 0n;
    try { owed = BigInt(intent.amount); } catch { return false; }
    if (owed <= 0n) return false;
    const ops = pendingOperations(pending);
    if (ops.length === 0) return false;
    let dest = null;
    try { dest = accountFrom(intent.from); } catch { dest = null; }
    const destText = accountKey(dest);
    let sum = 0n;
    for (const op of ops) {
      if (op?.type !== 0 && op?.type !== "SEND") return false;
      if (!isKoreSendToken(op?.token)) return false;
      const toText = accountKey(op?.to);
      if (!toText || (toText !== destText && toText !== intent.from)) return false;
      if (op.external !== intent.key) return false;
      if (typeof op.amount !== "bigint") return false;
      sum += op.amount;
    }
    return sum === owed;
  }

  function pendingHashes(pending) {
    const hashes = [];
    for (const block of pendingBlocksOf(pending)) {
      const hash = hashText(block?.hash ?? block?.blocksHash);
      if (hash) hashes.push(hash);
    }
    if (hashes.length === 0) {
      const hash = hashText(pending?.hash);
      if (hash) hashes.push(hash);
    }
    if (hashes.length === 0) hashes.push(`pending:${String(pending?.date ?? "none")}`);
    return hashes;
  }

  function noteLeftPick(pending) {
    for (const hash of pendingHashes(pending)) {
      if (leftPickNoted.has(hash)) continue;
      leftPickNoted.add(hash);
      console.log("Picks off. Leaving the pending pick block to expire.");
    }
  }

  function payoutVoteCap() {
    rollPayoutFeeDay();
    const room = payoutFeeBudget() - state.payoutFeeSpent;
    if (room <= 0n) return 0n;
    const cap = payoutFeeCap();
    return room < cap ? room : cap;
  }

  function samePendingBlock(block, pending) {
    if (!block || !pending) return false;
    if (block === pending) return true;
    const hash = hashText(block?.hash ?? block?.blocksHash);
    if (hash && hash === hashText(pending?.hash)) return true;
    for (const item of pendingBlocksOf(pending)) {
      if (item === block) return true;
      if (hash && hash === hashText(item?.hash ?? item?.blocksHash)) return true;
    }
    return false;
  }

  function extraKtaFee(staple, pending) {
    const blocks = Array.isArray(staple?.blocks) ? staple.blocks : [];
    const extras = blocks.filter((block) => !samePendingBlock(block, pending));
    if (extras.length === 0) return null;
    let sum = 0n;
    for (const block of extras) {
      for (const op of Array.isArray(block?.operations) ? block.operations : []) {
        if (op?.type !== 0 && op?.type !== "SEND") continue;
        if (!tokenIsKta(op?.token, base, baseText)) continue;
        try {
          if (op.amount === undefined || op.amount === null) continue;
          sum += BigInt(op.amount);
        } catch { /* not a fee amount */ }
      }
    }
    return sum;
  }

  async function finishSignedBlock() {
    const pending = await client.pendingBlock();
    if (!pending) return false;
    const when = blockTime(pending);
    if (Number.isFinite(when) && now() - when > 6 * 60 * 1000) {
      console.log("Finishing the block already signed.");
      console.log("Leaving the expired block. It cannot gather enough votes.");
      return "expired";
    }
    const payout = isPendingPayout(pending);
    // Payouts can stall for up to about 6 minutes while a pending pick block expires.
    if (picksPaused() && !payout) {
      noteLeftPick(pending);
      return "wait";
    }
    console.log("Finishing the block already signed.");
    try {
      const blocks = pendingBlocksOf(pending);
      await pauseForRate();
      let quotes;
      let quoteKnown = false;
      if (blocks.length > 0 && typeof client.getQuotes === "function") {
        try {
          quotes = await client.getQuotes(blocks);
          quoteKnown = true;
        } catch {
          quotes = undefined;
          quoteKnown = false;
        }
      }
      const quoted = quotesFee(quotes);
      const cap = payout ? payoutVoteCap() : bundleCap();
      if (payout) {
        rollPayoutFeeDay();
        if (state.payoutFeeSpent + quoted.amount > payoutFeeBudget()) {
          const line = `ALERT Payout fee budget for today is used up (${kta(state.payoutFeeSpent)} of ${kta(payoutFeeBudget())} KTA). Payouts wait until the next UTC day.`;
          if (line !== payoutBlockNoted) {
            payoutBlockNoted = line;
            console.error(line);
          }
          await sleep(30000);
          return "queued";
        }
      }
      if (quotes != null && quoted.foreign) {
        noteRefusedFees(quotes);
        if (!payout) {
          tripFee(quoted.shown, true);
          return "wait";
        }
        throw nonKtaError(quoted.shown, cap);
      }
      if (quotes != null && !quoted.usable) {
        noteRefusedFees(quotes);
        throw new FeeUnusable();
      }
      if (quoted.amount > cap) {
        noteRefusedFees(quotes);
        if (!payout) {
          tripFee(quoted.amount, false);
          return "wait";
        }
        throw new FeeOverCap(quoted.amount, cap);
      }
      if (!takeBlocks(Math.max(blocks.length, 1) + 1, payout ? "payout" : "signed block")) return "wait";
      const { generateFeeBlock, taken } = cappedFeeBlock(cap);
      const recovered = await client.recover(true, { generateFeeBlock, quotes });
      if (recovered == null) return false;
      clearEpisode();
      let charged = 0n;
      if (payout) {
        if (taken.used) charged = taken.fee;
        else {
          const extra = extraKtaFee(recovered, pending);
          if (extra !== null) charged = extra;
          else if (quoteKnown) charged = quoted.amount;
          else charged = cap;
        }
        rollPayoutFeeDay();
        state.payoutFeeSpent += charged;
        payoutBlockNoted = "";
      }
      notePublish();
      if (payout) console.log(`Payout fee ${kta(charged)} KTA. Today ${kta(state.payoutFeeSpent)} KTA.`);
      const left = await client.balance(base);
      const remaining = state.windowStart + DAY_MS - now();
      const planNow = pace({ balance: left, remainingMs: remaining, reserve: RESERVE, feePerTx: state.feePerTx ?? FEE_PER_TX });
      const publishedFee = taken.used ? taken.fee : 0n;
      sayPublished(true, planNow.tpsMilli, publishedFee, state.spent, left, 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      if (message.includes("enough voting power") || message.includes("INSUFFICIENT_VOTING_WEIGHT")) {
        console.log("Leaving the short block. It cannot gather enough votes.");
        return "wait";
      }
      if (!payout && isOverCap(err)) {
        tripFee(err.fee ?? 0n, err.nonKta === true);
        return "wait";
      }
      throw err;
    }
    return true;
  }

  async function settleExpiredIntent() {
    const intent = readIntent();
    if (!intent) return;
    const koreBal = await client.balance(kore);
    const verdict = judgeIntent(koreBal, intent);
    if (verdict === "paid") {
      if (settlePayout(koreBal) === "paid") koreStart = await client.balance(kore);
      return;
    }
    if (verdict !== "missed") {
      holdPayouts("Balance does not match this payout.");
      return;
    }
    try { unlinkSync(`${dir}/PAYHOLD`); } catch { /* none */ }
    clearFloor(BigInt(intent.floor));
    clearIntent();
    writeState(state);
    console.log("KORE send did not land. Nothing was marked paid. Payout stays queued.");
  }

  try {
    const first = await finishSignedBlock();
    if (first === true) console.log("Signed block is on the chain.");
    if (first === "expired") await settleExpiredIntent();
  } catch (err) {
    if (isOverCap(err)) {
      const delay = armEpisode(err);
      await sleep(delay);
    } else if (isUnusable(err)) {
      await sleep(30000);
    } else {
      console.error("Recover failed.", err instanceof Error ? err.message : "unknown");
    }
  }

  console.log(configLine(blocksInHour(state.recent, now())));
  if (existsSync(rateHoldPath)) writeStatus("paused", `RATEHOLD: ${holdReason(rateHoldPath)}`);
  else if (existsSync(feeHoldPath)) writeStatus("paused", `FEEHOLD: ${holdReason(feeHoldPath)}`);
  else writeStatus("running", picksOff() ? "picks off" : "starting");
  console.log("Runner up. Pace follows fuel. Ceiling 17/s. Reserve", kta(RESERVE), "KTA.", sendArmed() ? "KORE send is armed." : "KORE send is off.");
  console.log(closeAccrue ? "Close accrue on" : "Close accrue off");
  console.log("Dust sink:", sink);
  console.log("KORE:", koreStart.toString());

  function halt(reason) {
    writeFileSync(`${dir}/HALT`, `${reason}\n`);
    console.error("HALT.", reason);
    process.exit(0);
  }

function holdPayouts(reason) {
  const path = `${dir}/PAYHOLD`;
  if (!existsSync(path)) console.error("KORE sends wait.", reason, "Mining continues.");
  writeFileSync(path, `${reason}\n`);
}

function settlePayout(koreBal) {
    const intent = readIntent();
    if (!intent) return "none";
    const verdict = judgeIntent(koreBal, intent);
    if (verdict === "hold") {
      holdPayouts("Balance does not match this payout.");
      return "hold";
    }
    if (verdict === "missed") {
      try { unlinkSync(`${dir}/PAYHOLD`); } catch { /* none */ }
      clearFloor(BigInt(intent.floor));
      clearIntent();
      console.log("KORE send did not land. Nothing was marked paid.");
      return "missed";
    }
    const applied = applyPaid(books.share, intent);
    if (applied === "halt") {
      holdPayouts("The books do not match this payout.");
      return "hold";
    }
    try { unlinkSync(`${dir}/PAYHOLD`); } catch { /* none */ }
    saveBooks(books);
    clearIntent();
    console.log("Paid", intent.amount, "KORE to", intent.from);
    if (!state.done.includes(intent.from)) state.done.push(intent.from);
    writeState(state);
    return "paid";
  }

  function beginClose(at) {
    const today = new Date(at).toISOString().slice(0, 10);
    if (!state.payoutDay) {
      state.payoutDay = today;
      state.done = [];
      state.closeOpen = false;
      writeState(state);
      console.log("Payouts wait for the next close.");
      return;
    }
    if (state.payoutDay !== today) {
      state.payoutDay = today;
      state.done = [];
      state.closeOpen = true;
      writeState(state);
      console.log("Close. One send per wallet.");
    }
  }

  function pendingTotal(share) {
    let sum = 0n;
    for (const amount of share.pending.values()) sum += amount;
    return sum;
  }

  function kore6(units) {
    const neg = units < 0n;
    const value = neg ? -units : units;
    const whole = value / 1_000_000_000_000n;
    const frac = (value % 1_000_000_000_000n).toString().padStart(12, "0").slice(0, 6);
    return `${neg ? "-" : ""}${whole.toString()}.${frac}`;
  }

  async function payOne(wallet, status, chainRetry) {
    if (existsSync(`${dir}/PAYHOLD`)) return "skip";
    if (readIntent()) return "pending";
    if (closeAccrue) {
      const edge = dayStart(now());
      const at = now();
      if (books.share.lastMs >= edge) {
        // Already credited, or a real staple landed after the edge.
      } else if (at - edge < 120_000) {
        return "skip";
      } else if (at - edge >= 30 * 60 * 1000) {
        if (!closeCreditGaveUp) {
          closeCreditGaveUp = true;
          console.log("Close credit skipped. Normal close.");
        }
      } else if (status !== "ok" || chainRetry) {
        if (closeCreditWaitAt === null || at - closeCreditWaitAt >= 60_000) {
          closeCreditWaitAt = at;
          console.log(`Close credit waits. Books ${status}.`);
        }
        return "skip";
      } else {
        const before = pendingTotal(books.share);
        accrue(books.share, edge);
        const credited = pendingTotal(books.share) - before;
        saveBooks(books);
        console.log(`Close credit to ${new Date(edge).toISOString()}. KORE ${kore6(credited)}.`);
      }
    }
    beginClose(now());
    if (!state.closeOpen) return "skip";
    const row = choosePayout(books.share, { intake, sink, skip: state.done });
    if (!row || due(books.share, row.from) !== row.amount) {
      state.closeOpen = false;
      writeState(state);
      console.log("Close paid.");
      return "skip";
    }
    let dest;
    try {
      dest = accountFrom(row.from);
    } catch {
      state.done = Array.isArray(state.done) ? state.done : [];
      if (!state.done.includes(row.from)) state.done.push(row.from);
      writeState(state);
      console.log("Skip KORE. Address does not decode.", row.from);
      return "skip";
    }
    const builder = client.initBuilder();
    builder.send(dest, row.amount, koreAccount, row.key);
    const built = await builder.computeBlocks();
    await pauseForRate();
    const quotes = await client.getQuotes(built.blocks);
    const quoted = quotes == null
      ? { amount: 0n, foreign: false, shown: 0n, usable: false }
      : quotesFee(quotes);
    if (quoted.foreign) {
      noteRefusedFees(quotes);
      throw nonKtaError(quoted.shown, payoutFeeCap());
    }
    if (!quoted.usable) {
      noteRefusedFees(quotes);
      await sleep(30000);
      return "queued";
    }
    const fee = quoted.amount;
    const spendable = wallet > RESERVE ? wallet - RESERVE : 0n;
    if (fee > 0n) {
      const judged = judgeQuote({ quote: fee, ops: 1n, spendable, feePerTx: state.feePerTx ?? FEE_PER_TX, cap: payoutFeeCap() });
      if (!judged.ok) {
        if (judged.reason === "cap") {
          const line = `ALERT Payout fee ${kta(fee)} KTA is over the ${kta(payoutFeeCap())} KTA payout cap. Payout stays queued.`;
          if (line !== payoutBlockNoted) {
            payoutBlockNoted = line;
            noteRefusedFees(quotes);
            console.error(line);
          }
          await sleep(30000);
          return "queued";
        }
        state.done = Array.isArray(state.done) ? state.done : [];
        if (!state.done.includes(row.from)) state.done.push(row.from);
        writeState(state);
        console.log(judged.reason === "reserve" ? "KORE waiting. Fee would spend the reserve." : "Skip KORE. Quote", kta(fee), "KTA.");
        return "skip";
      }
    }
    rollPayoutFeeDay();
    if (state.payoutFeeSpent + fee > payoutFeeBudget()) {
      const line = `ALERT Payout fee budget for today is used up (${kta(state.payoutFeeSpent)} of ${kta(payoutFeeBudget())} KTA). Payouts wait until the next UTC day.`;
      if (line !== payoutBlockNoted) {
        payoutBlockNoted = line;
        console.error(line);
      }
      await sleep(30000);
      return "queued";
    }
    const koreBal = await client.balance(kore);
    const floor = floorAfter(koreBal, row.amount);
    if (floor === null) {
      state.done = Array.isArray(state.done) ? state.done : [];
      if (!state.done.includes(row.from)) state.done.push(row.from);
      writeState(state);
      console.log("Skip KORE. Amount does not fit.", row.from);
      return "skip";
    }
    if (!takeBlocks(built.blocks.length + 1, "payout")) return "queued";
    const intent = { from: row.from, amount: row.amount.toString(), key: row.key, floor: floor.toString() };
    writeJson(intentPath, intent);
    writeFileSync(floorPath, `${floor.toString()}\n`, { mode: 0o600 });
    try {
      const published = await publishCapped(builder, quotes, payoutVoteCap());
      clearEpisode();
      const charged = published.fee > 0n ? published.fee : fee;
      rollPayoutFeeDay();
      state.payoutFeeSpent += charged;
      notePublish();
      payoutBlockNoted = "";
      console.log(`Payout fee ${kta(charged)} KTA. Today ${kta(state.payoutFeeSpent)} KTA.`);
      const left = await client.balance(base);
      const remaining = state.windowStart + DAY_MS - now();
      const planNow = pace({ balance: left, remainingMs: remaining, reserve: RESERVE, feePerTx: state.feePerTx ?? FEE_PER_TX });
      sayPublished(published.result?.publish === true || Boolean(published.result?.voteStaple), planNow.tpsMilli, published.fee, state.spent, left, 0);
    } catch (err) {
      if (isOverCap(err) || isUnusable(err)) {
        if (!(await client.pendingBlock())) {
          clearIntent();
          clearFloor(floor);
        }
        throw err;
      }
      console.error("KORE send failed.", err instanceof Error ? err.message : "unknown");
      return "pending";
    }
    const after = await client.balance(kore);
    if (settlePayout(after) === "halt") return "halt";
    return after === floor ? "paid" : "pending";
  }

  let sendOn = sendArmed();
  let ran = 0;
  let picksOffNotedAt = null;
  function notePicksOff() {
    const at = now();
    if (picksOffNotedAt !== null && at - picksOffNotedAt < 10 * 60 * 1000) return;
    picksOffNotedAt = at;
    console.log("Picks off. Payouts only.");
  }
  while (!existsSync(`${dir}/STOP`)) {
    if (ran >= steps) break;
    if (existsSync(`${dir}/HALT`)) {
      console.log("HALT file present. Stopping.");
      break;
    }
    ran += 1;
    try {
      refreshStatus();
      if (picksOff()) notePicksOff();
      if (now() - state.windowStart >= DAY_MS) {
        state = {
          windowStart: now(),
          spent: 0n,
          feePerTx: clampFeePerTx(state.feePerTx ?? FEE_PER_TX),
          payoutDay: state.payoutDay ?? "",
          done: state.done ?? [],
          closeOpen: state.closeOpen === true,
          lastPublishMs: state.lastPublishMs || 0,
          payoutFeeDay: state.payoutFeeDay ?? "",
          payoutFeeSpent: state.payoutFeeSpent ?? 0n,
          recent: Array.isArray(state.recent) ? state.recent : [],
        };
        writeState(state);
        console.log("New day. Pace window reset.");
      }
      rollPayoutFeeDay();
      if (existsSync(rateHoldPath)) {
        const why = holdReason(rateHoldPath);
        notePaused(`RATEHOLD ${why}`, "Nothing publishes.");
        writeStatus("paused", `RATEHOLD: ${why}`);
        feeChecked = false;
        await sleep(30000);
        continue;
      }

      const chain = await syncChain(books);
      if (chain === "halt-reserve") {
        writeFileSync(`${dir}/HALT`, "burn would spend the reserve\n");
        console.error("HALT. Burn would spend the reserve.");
        process.exit(0);
      }
      const balance = await client.balance(base);
      const status = reconcile(books, balance, chain, now());
      saveBooks(books);
      try {
        if (applyClaimFile(books, dir)) saveBooks(books);
      } catch (err) {
        console.error("Claim skipped.", err instanceof Error ? err.message : "unknown");
      }
      try {
        if (applyLinks(books, readLinks(linksPath))) saveBooks(books);
      } catch (err) {
        console.error("Link skipped.", err instanceof Error ? err.message : "unknown");
      }
      if (status === "halt-reserve") {
        writeFileSync(`${dir}/HALT`, "burn would spend the reserve\n");
        console.error("HALT. Burn would spend the reserve.");
        process.exit(0);
      }
      const gate = await finishSignedBlock();
      if (gate === "expired") await settleExpiredIntent();
      if (gate === "queued") continue;
      if (gate === true || gate === "wait") {
        if (gate === true) await pauseForRate();
        if (gate === "wait") await sleep(10000);
        continue;
      }
      const settled = settlePayout(await client.balance(kore));
      if (settled === "paid") koreStart = await client.balance(kore);
      const picksWait = status !== "ok";
      const closeWaits = picksWait && status !== "missing-deposit" && status !== "waiting-burn";
      let wallet = balance;
      let justSent = false;
      if (!closeWaits) {
        const armed = sendArmed();
        if (armed !== sendOn) {
          sendOn = armed;
          console.log(sendOn ? "KORE send armed." : "KORE send is off.");
          saveBooks(books);
        }
        if (sendOn && settled !== "hold") {
          const mark = state.lastPublishMs;
          const paid = await payOne(wallet, status, chainRetry);
          justSent = state.lastPublishMs !== mark;
          if (paid === "halt" || paid === "hold") console.error("KORE sends wait. Mining continues.");
          if (paid === "paid") {
            wallet = await client.balance(base);
            koreStart = await client.balance(kore);
          }
        }
      }
      if (picksWait) {
        console.log("Books", status, "Balance", kta(balance), "KTA.", status === "missing-deposit" || status === "waiting-burn" ? "Picks wait." : "Payouts wait.");
        await sleep(10000);
        continue;
      }

      if (picksPaused()) {
        feeChecked = false;
        if (existsSync(feeHoldPath)) {
          const why = holdReason(feeHoldPath);
          notePaused(`FEEHOLD ${why}`, "Picks paused. Payouts still run.");
          writeStatus("paused", `FEEHOLD: ${why}`);
        } else {
          writeStatus("running", "picks off");
        }
        const koreNow = await client.balance(kore);
        if (koreNow > koreStart) {
          console.log("Extra KORE ignored.", koreNow.toString());
          koreStart = koreNow;
        } else if (koreNow < koreStart) {
          const floor = recordedKoreFloor();
          if (floor !== null && koreNow === floor) {
            console.log("KORE payout recorded. Floor", koreNow.toString());
            koreStart = koreNow;
          } else {
            holdPayouts("KORE moved without a matching payout.");
          }
        }
        if (!justSent) await sleep(30000);
        continue;
      }

      const remaining = state.windowStart + DAY_MS - now();
      const plan = pace({ balance: wallet, remainingMs: remaining, reserve: RESERVE, feePerTx: state.feePerTx });
      if (plan.tpsMilli === 0n || plan.pack === 0 || wallet < BLOCK_FEE + RESERVE) {
        console.log("Holding the payout reserve. Balance", kta(balance), "KTA.");
        await sleep(60000);
        continue;
      }

      const again = await finishSignedBlock();
      if (again === "expired") await settleExpiredIntent();
      if (again === "queued") continue;
      if (again === true || again === "wait") {
        if (again === true) await pauseForRate();
        if (again === "wait") await sleep(10000);
        continue;
      }

      if (!feeChecked && now() < feeRetryAt) {
        await sleep(30000);
        continue;
      }
      const started = now();
      blockNo += 1;
      let pack = plan.pack;
      let builder;
      let built;
      let ops = 0;
      while (pack >= 1) {
        builder = client.initBuilder();
        for (let i = 0; i < pack; i += 1) builder.send(dustAccount, 1n, base, `r${blockNo}-${i}-${started}`);
        built = await builder.computeBlocks();
        ops = built.blocks.reduce((sum, block) => sum + block.operations.length, 0);
        if (built.blocks.length === 1 && ops === pack) break;
        pack = Math.floor(pack / 2);
        builder = null;
      }
      if (!builder || built.blocks.length !== 1 || ops !== pack) {
        console.log("Skip. Block did not fit.", ops);
        await sleep(30000);
        continue;
      }
      await pauseForRate();
      let quotes;
      try {
        quotes = await client.getQuotes(built.blocks);
      } catch (err) {
        if (feeChecked) throw err;
        quotes = undefined;
      }
      const quoted = quotes == null
        ? { amount: 0n, foreign: false, shown: 0n, usable: false }
        : quotesFee(quotes);
      if (!feeChecked) {
        // Pre-start fee check on the real quote path. Quote only; fails closed.
        let why = "";
        if (quotes == null || quotes.length === 0 || !quoted.usable) why = "no usable fee quote";
        else if (quoted.foreign) why = "the quote is not in KTA";
        else if (quoted.amount > bundleCap()) why = `fee ${kta(quoted.amount)} KTA a block is over the ${kta(bundleCap())} KTA cap`;
        if (why) {
          const at = now();
          if (why !== feeSkipNoted || feeSkipAt === null || at - feeSkipAt >= 10 * 60 * 1000) {
            feeSkipNoted = why;
            feeSkipAt = at;
            console.log(`SKIP: ${why}. Picks not started.`);
          }
          if (quotes != null && quoted.foreign) tripFee(quoted.shown, true);
          else if (quotes != null && quoted.usable && quoted.amount > bundleCap()) tripFee(quoted.amount, false);
          else {
            writeStatus("running", `picks waiting: ${why}`);
            feeRetryAt = now() + 10 * 60 * 1000;
            await sleep(30000);
          }
          continue;
        }
        feeChecked = true;
        feeSkipNoted = "";
        console.log(`Fee check ok: ${kta(quoted.amount)} KTA a block, cap ${kta(bundleCap())} KTA. Picks start.`);
        writeStatus("running", "picks on");
      }
      if (quoted.foreign) {
        noteRefusedFees(quotes);
        tripFee(quoted.shown, true);
        continue;
      }
      if (!quoted.usable) {
        noteRefusedFees(quotes);
        await sleep(30000);
        continue;
      }
      const total = quoted.amount;
      if (total > 0n) {
        const judged = judgeQuote({
          quote: total,
          ops: BigInt(ops),
          spendable: plan.spendable,
          feePerTx: state.feePerTx,
        });
        if (!judged.ok) {
          if (judged.reason === "cap") {
            noteRefusedFees(quotes);
            tripFee(total, false);
            continue;
          }
          state.feePerTx = judged.learn;
          writeState(state);
          console.log(judged.reason === "reserve" ? "Quote would spend the payout reserve. Quote" : "Skip. Quote", kta(total), "KTA. Ops", ops);
          await sleep(30000);
          continue;
        }
        state.feePerTx = judged.learn;
      }

      if (!takeBlocks(built.blocks.length + 1, "pick")) {
        await sleep(30000);
        continue;
      }
      const before = await client.balance(base);
      let published;
      try {
        published = await publishCapped(builder, quotes);
      } catch (err) {
        if (isOverCap(err)) {
          tripFee(err.fee ?? 0n, err.nonKta === true);
          continue;
        }
        throw err;
      }
      clearEpisode();
      const after = await client.balance(base);
      const drop = before > after ? before - after : total;
      state.spent += drop;
      state.lastPublishMs = now();
      writeState(state);
      notePublished(books, drop, now());
      saveBooks(books);
      const elapsed = now() - started;
      sayPublished(published.result?.publish === true || Boolean(published.result?.voteStaple), plan.tpsMilli, published.fee, state.spent, after, elapsed);

      const koreNow = await client.balance(kore);
      if (koreNow > koreStart) {
        console.log("Extra KORE ignored.", koreNow.toString());
        koreStart = koreNow;
      } else if (koreNow < koreStart) {
        const floor = recordedKoreFloor();
        if (floor !== null && koreNow === floor) {
          console.log("KORE payout recorded. Floor", koreNow.toString());
          koreStart = koreNow;
        } else {
          holdPayouts("KORE moved without a matching payout.");
        }
      }
      const paceWait = elapsed < plan.intervalMs ? plan.intervalMs - elapsed : 0;
      const wait = Math.max(paceWait, rateWait());
      if (wait > 0) await sleep(wait);
    } catch (err) {
      if (isOverCap(err)) {
        const delay = armEpisode(err);
        await sleep(delay);
        continue;
      }
      if (isUnusable(err)) {
        await sleep(30000);
        continue;
      }
      const message = err instanceof Error ? err.message : "unknown";
      console.error("Retry.", message);
      if (message.includes("existing vote for a successor")) {
        try {
          await finishSignedBlock();
        } catch (recoverErr) {
          if (isOverCap(recoverErr)) {
            const delay = armEpisode(recoverErr);
            await sleep(delay);
            continue;
          }
          if (isUnusable(recoverErr)) {
            await sleep(30000);
            continue;
          }
          console.error("Recover failed.", recoverErr instanceof Error ? recoverErr.message : "unknown");
        }
      }
      await sleep(10000);
    }
  }

  console.log("Stopped.");
  await client.destroy?.();
}

async function main() {
  const dir = defaultDir;
  if (process.argv.includes("--dry-run")) {
    const { runDry } = await import("./pay-dry.mjs");
    runDry(process.argv);
    process.exit(0);
  }
  if (existsSync(`${dir}/STOP`) || existsSync(`${dir}/HALT`)) {
    console.log("Stop file present. Not running.");
    process.exit(0);
  }
  const seedPath = `${dir}/seed.txt`;
  const phrase = readFileSync(seedPath, "utf8").trim().toLowerCase().replace(/\s+/g, " ");
  const KeetaNet = await import("@keetanetwork/keetanet-client");
  const hex = await KeetaNet.lib.Account.seedFromPassphrase(phrase, { asString: true });
  const wallet = KeetaNet.lib.Account.fromSeed(String(hex), 0);
  if (wallet.publicKeyString.toString() !== intake) {
    console.error("Stop. Seed is not the intake wallet.");
    process.exit(1);
  }
  writeFileSync(`${dir}/sink.txt`, `${sink}\n`, { mode: 0o644 });
  const base = KeetaNet.lib.Account.generateBaseAddresses(0x5382n).baseToken;
  const dustAccount = KeetaNet.lib.Account.fromPublicKeyString(sink);
  const client = KeetaNet.UserClient.fromNetwork("main", wallet);
  const baseText = base.publicKeyString.toString();
  await runShaft({
    dir,
    client,
    base,
    baseText,
    dustAccount,
    koreAccount: KeetaNet.lib.Account.fromPublicKeyString(kore),
    accountFrom: (id) => KeetaNet.lib.Account.fromPublicKeyString(id),
  });
}

function startedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) await main();
