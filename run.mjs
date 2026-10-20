import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, unlinkSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BLOCK_FEE, DAY_MS, FEE_PER_TX, FeeOverCap, bundleCap, configLine, judgeQuote, kta, minPublishGapMs, pace, payoutFeeBudget, payoutFeeCap, picksOff } from "./pace.mjs";
import { RESERVE, due } from "./share.mjs";
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

  function cappedFeeBlock(cap = bundleCap()) {
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

  async function publishCapped(builder, quotes, cap = bundleCap()) {
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
      };
    } catch {
      return { windowStart: now(), spent: 0n, feePerTx: FEE_PER_TX, payoutDay: "", done: [], closeOpen: false, lastPublishMs: 0, payoutFeeDay: "", payoutFeeSpent: 0n };
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
    if (named === "retry") return books.share.lastMs;
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

  function pendingOperations(pending) {
    const ops = [];
    for (const block of Array.isArray(pending?.blocks) ? pending.blocks : []) {
      for (const op of Array.isArray(block?.operations) ? block.operations : []) ops.push(op);
    }
    return ops;
  }

  function partyText(value) {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value === "string") return value;
    if (typeof value?.id === "string") return value.id;
    const key = value?.publicKeyString;
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

  function isKoreToken(token) {
    if (token === koreAccount) return true;
    if (token?.id && koreAccount?.id && token.id === koreAccount.id) return true;
    const text = partyText(token);
    if (!text) return false;
    if (text === kore || text === koreAccount?.id) return true;
    const accountKey = koreAccount?.publicKeyString;
    if (typeof accountKey?.toString === "function" && text === accountKey.toString()) return true;
    return false;
  }

  function isKoreSend(op) {
    const type = op?.type;
    const send = type === undefined || type === null || type === 0 || type === "0" || type === "SEND";
    return send && isKoreToken(op?.token);
  }

  function isPendingPayout(pending) {
    const intent = readIntent();
    if (!intent || typeof intent.from !== "string") return false;
    let owed = 0n;
    try { owed = BigInt(intent.amount); } catch { return false; }
    if (owed <= 0n) return false;
    const ops = pendingOperations(pending);
    if (ops.length === 0) return false;
    let dest = null;
    try { dest = accountFrom(intent.from); } catch { dest = null; }
    const destText = partyText(dest);
    let sum = 0n;
    for (const op of ops) {
      if (!isKoreSend(op)) return false;
      const toText = partyText(op?.to);
      if (!((destText && toText === destText) || toText === intent.from || op?.to === dest)) return false;
      try {
        if (op?.amount === undefined || op?.amount === null) return false;
        sum += BigInt(op.amount);
      } catch {
        return false;
      }
    }
    return sum === owed;
  }

  function pendingHashes(pending) {
    const hashes = [];
    for (const block of Array.isArray(pending?.blocks) ? pending.blocks : []) {
      const hash = block?.hash ?? block?.blocksHash;
      if (typeof hash === "string" && hash) hashes.push(hash);
    }
    if (hashes.length === 0 && typeof pending?.hash === "string" && pending.hash) hashes.push(pending.hash);
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
    const cappedRoom = room > 0n ? room : 0n;
    const cap = payoutFeeCap();
    return cappedRoom < cap ? cappedRoom : cap;
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
    if (picksOff() && !payout) {
      noteLeftPick(pending);
      return "wait";
    }
    console.log("Finishing the block already signed.");
    try {
      const blocks = Array.isArray(pending.blocks) ? pending.blocks : [];
      await pauseForRate();
      let quotes;
      if (blocks.length > 0 && typeof client.getQuotes === "function") quotes = await client.getQuotes(blocks);
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
      const recovered = await client.recover(true, { generateFeeBlock, quotes });
      clearEpisode();
      let charged = 0n;
      if (payout) {
        charged = taken.used && taken.fee > 0n ? taken.fee : quoted.amount;
        rollPayoutFeeDay();
        state.payoutFeeSpent += charged;
        payoutBlockNoted = "";
      }
      notePublish();
      if (payout) console.log(`Payout fee ${kta(charged)} KTA. Today ${kta(state.payoutFeeSpent)} KTA.`);
      const left = await client.balance(base);
      const remaining = state.windowStart + DAY_MS - now();
      const planNow = pace({ balance: left, remainingMs: remaining, reserve: RESERVE, feePerTx: state.feePerTx ?? FEE_PER_TX });
      sayPublished(recovered?.publish === true || Boolean(recovered?.voteStaple), planNow.tpsMilli, taken.used ? taken.fee : 0n, state.spent, left, 0);
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      if (message.includes("enough voting power") || message.includes("INSUFFICIENT_VOTING_WEIGHT")) {
        console.log("Leaving the short block. It cannot gather enough votes.");
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
    if (!state.done.includes(intent.from)) state.done.push(intent.from);
    try { unlinkSync(`${dir}/PAYHOLD`); } catch { /* none */ }
    clearFloor(BigInt(intent.floor));
    clearIntent();
    writeState(state);
    console.log("KORE send did not land. Nothing was marked paid.");
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

  console.log(configLine());
  console.log("Runner up. Pace follows fuel. Ceiling 17/s. Reserve", kta(RESERVE), "KTA.", sendArmed() ? "KORE send is armed." : "KORE send is off.");
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

  async function payOne(wallet) {
    if (existsSync(`${dir}/PAYHOLD`)) return "skip";
    if (readIntent()) return "pending";
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
    ran += 1;
    try {
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
        };
        writeState(state);
        console.log("New day. Pace window reset.");
      }
      rollPayoutFeeDay();

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
          const paid = await payOne(wallet);
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

      if (picksOff()) {
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
      const quotes = await client.getQuotes(built.blocks);
      const quoted = quotes == null
        ? { amount: 0n, foreign: false, shown: 0n, usable: false }
        : quotesFee(quotes);
      if (quoted.foreign) {
        noteRefusedFees(quotes);
        throw nonKtaError(quoted.shown, bundleCap());
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
            throw new FeeOverCap(total, bundleCap());
          }
          state.feePerTx = judged.learn;
          writeState(state);
          console.log(judged.reason === "reserve" ? "Quote would spend the payout reserve. Quote" : "Skip. Quote", kta(total), "KTA. Ops", ops);
          await sleep(30000);
          continue;
        }
        state.feePerTx = judged.learn;
      }

      const before = await client.balance(base);
      const published = await publishCapped(builder, quotes);
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
