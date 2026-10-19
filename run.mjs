import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import * as KeetaNet from "@keetanetwork/keetanet-client";
import { BLOCK_FEE, DAY_MS, FEE_PER_TX, judgeQuote, kta, pace } from "./pace.mjs";
import { RESERVE, due } from "./share.mjs";
import { booksFromJson, booksToJson, ingest, notePublished, payoutPlan, publicBooks, reconcile } from "./books.mjs";
import { pullNew, readStaple } from "./chain.mjs";
import { applyPaid, choosePayout, floorAfter, judgeIntent } from "./pay.mjs";
import { applyClaimFile } from "./claim.mjs";

const intake =
  "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const kore =
  "keeta_apu6efya45r6rirjwyhl25djcuqg53zlepwctj7xpzvmrhfwckrzxwht4sypk";
const sink =
  "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const dir = "/opt/koreminer";
const seedPath = `${dir}/seed.txt`;
const sinkPath = `${dir}/sink.txt`;
const statePath = `${dir}/state.json`;
const booksPath = `${dir}/books.json`;
const planPath = `${dir}/payout-plan.json`;
const intentPath = `${dir}/payout-intent.json`;
const floorPath = `${dir}/kore-floor.txt`;
const lookupPath = `${dir}/lookup.json`;
const publicLookup = "/var/www/koreminer/lookup.json";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function feeSum(quote) {
  if (!quote?.fee) return 0n;
  const fees = Array.isArray(quote.fee) ? quote.fee : [quote.fee];
  return fees.reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
}

function readState() {
  try {
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      windowStart: Number(saved.windowStart) || Date.now(),
      spent: BigInt(saved.spent ?? "0"),
      feePerTx: BigInt(saved.feePerTx ?? FEE_PER_TX.toString()),
      payoutFee: BigInt(saved.payoutFee ?? saved.feePerTx ?? FEE_PER_TX.toString()),
      payoutDay: typeof saved.payoutDay === "string" ? saved.payoutDay : "",
      done: Array.isArray(saved.done) ? saved.done.filter((item) => typeof item === "string") : [],
      closeOpen: saved.closeOpen === true,
    };
  } catch {
    return { windowStart: Date.now(), spent: 0n, feePerTx: FEE_PER_TX, payoutFee: FEE_PER_TX, payoutDay: "", done: [], closeOpen: false };
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

async function syncChain(books, baseText) {
  const rows = await pullNew(client, books.cursor);
  const staples = [];
  for (const row of rows) {
    const staple = readStaple(row, baseText);
    if (staple) staples.push(staple);
  }
  staples.sort((a, b) => a.timeMs - b.timeMs);
  for (const staple of staples) {
    if (ingestSafe(books, staple) === "halt-reserve") return "halt-reserve";
  }
  if (rows.length > 0) books.cursor = rows[0].voteStaple.blocksHash.toString();
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
    payoutFee: (state.payoutFee ?? state.feePerTx ?? FEE_PER_TX).toString(),
    payoutDay: state.payoutDay ?? "",
    done: state.done ?? [],
    closeOpen: state.closeOpen === true,
  });
  writeFileSync(`${statePath}.tmp`, body);
  renameSync(`${statePath}.tmp`, statePath);
}

function recordedKoreFloor() {
  try {
    const text = readFileSync(`${dir}/kore-floor.txt`, "utf8").trim();
    if (!/^[0-9]+$/.test(text)) return null;
    return BigInt(text);
  } catch {
    return null;
  }
}

if (existsSync(`${dir}/STOP`) || existsSync(`${dir}/HALT`)) {
  console.log("Stop file present. Not running.");
  process.exit(0);
}

const phrase = readFileSync(seedPath, "utf8").trim().toLowerCase().replace(/\s+/g, " ");
const hex = await KeetaNet.lib.Account.seedFromPassphrase(phrase, { asString: true });
const wallet = KeetaNet.lib.Account.fromSeed(String(hex), 0);
if (wallet.publicKeyString.toString() !== intake) {
  console.error("Stop. Seed is not the intake wallet.");
  process.exit(1);
}

writeFileSync(sinkPath, `${sink}\n`, { mode: 0o644 });

const base = KeetaNet.lib.Account.generateBaseAddresses(0x5382n).baseToken;
const dustAccount = KeetaNet.lib.Account.fromPublicKeyString(sink);
const client = KeetaNet.UserClient.fromNetwork("main", wallet);
const koreStartBalance = await client.balance(kore);
let koreStart = koreStartBalance;
let state = readState();
const books = loadBooks();
const baseText = base.publicKeyString.toString();
let blockNo = 0;

async function finishSignedBlock() {
  const pending = await client.pendingBlock();
  if (!pending) return false;
  console.log("Finishing the block already signed.");
  const when = pending.date instanceof Date ? pending.date.getTime() : Date.parse(String(pending.date));
  if (Number.isFinite(when) && Date.now() - when > 6 * 60 * 1000) {
    console.log("Leaving the expired block. It cannot gather enough votes.");
    return false;
  }
  try {
    await client.recover(true, {
      generateFeeBlock: async (staple) => {
        const builder = client.initBuilder();
        return builder.computeFeeBlock(staple);
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    if (message.includes("enough voting power") || message.includes("INSUFFICIENT_VOTING_WEIGHT")) {
      console.log("Leaving the short block. It cannot gather enough votes.");
      return false;
    }
    throw err;
  }
  return true;
}

try {
  if (await finishSignedBlock()) console.log("Signed block is on the chain.");
} catch (err) {
  console.error("Recover failed.", err instanceof Error ? err.message : "unknown");
}

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

function beginClose(now) {
  const today = new Date(now).toISOString().slice(0, 10);
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
  beginClose(Date.now());
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
    dest = KeetaNet.lib.Account.fromPublicKeyString(row.from);
  } catch {
    state.done = Array.isArray(state.done) ? state.done : [];
    if (!state.done.includes(row.from)) state.done.push(row.from);
    writeState(state);
    console.log("Skip KORE. Address does not decode.", row.from);
    return "skip";
  }
  const koreAccount = KeetaNet.lib.Account.fromPublicKeyString(kore);
  const builder = client.initBuilder();
  builder.send(dest, row.amount, koreAccount, row.key);
  const built = await builder.computeBlocks();
  const quotes = await client.getQuotes(built.blocks);
  const fee = quotes.map(feeSum).filter((item) => item > 0n).reduce((sum, item) => sum + item, 0n);
  const spendable = wallet > RESERVE ? wallet - RESERVE : 0n;
  const judged = judgeQuote({ quote: fee, ops: 1n, spendable, feePerTx: state.payoutFee ?? FEE_PER_TX });
  if (!judged.ok) {
    state.payoutFee = judged.learn;
    state.done = Array.isArray(state.done) ? state.done : [];
    if (!state.done.includes(row.from)) state.done.push(row.from);
    writeState(state);
    console.log(judged.reason === "reserve" ? "KORE waiting. Fee would spend the reserve." : "Skip KORE. Quote", kta(fee), "KTA.");
    return "skip";
  }
  state.payoutFee = judged.learn;
  writeState(state);
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
    await client.publishBuilder(builder);
  } catch (err) {
    console.error("KORE send failed.", err instanceof Error ? err.message : "unknown");
    return "pending";
  }
  const after = await client.balance(kore);
  if (settlePayout(after) === "halt") return "halt";
  return after === floor ? "paid" : "pending";
}

let sendOn = sendArmed();
while (!existsSync(`${dir}/STOP`)) {
  try {
    if (Date.now() - state.windowStart >= DAY_MS) {
      state = {
        windowStart: Date.now(),
        spent: 0n,
        feePerTx: state.feePerTx ?? FEE_PER_TX,
        payoutFee: state.payoutFee ?? FEE_PER_TX,
        payoutDay: state.payoutDay ?? "",
        done: state.done ?? [],
        closeOpen: state.closeOpen === true,
      };
      writeState(state);
      console.log("New day. Pace window reset.");
    }

    const chain = await syncChain(books, baseText);
    if (chain === "halt-reserve") {
      writeFileSync(`${dir}/HALT`, "burn would spend the reserve\n");
      console.error("HALT. Burn would spend the reserve.");
      process.exit(0);
    }
    const balance = await client.balance(base);
    const status = reconcile(books, balance, chain, Date.now());
    saveBooks(books);
    try {
      if (applyClaimFile(books, dir)) saveBooks(books);
    } catch (err) {
      console.error("Claim skipped.", err instanceof Error ? err.message : "unknown");
    }
    if (status === "halt-reserve") {
      writeFileSync(`${dir}/HALT`, "burn would spend the reserve\n");
      console.error("HALT. Burn would spend the reserve.");
      process.exit(0);
    }
    const settled = settlePayout(await client.balance(kore));
    if (settled === "paid") koreStart = await client.balance(kore);
    const picksWait = status !== "ok";
    const closeWaits = picksWait && status !== "missing-deposit" && status !== "waiting-burn";
    let wallet = balance;
    if (!closeWaits) {
      const armed = sendArmed();
      if (armed !== sendOn) {
        sendOn = armed;
        console.log(sendOn ? "KORE send armed." : "KORE send is off.");
        saveBooks(books);
      }
      if (sendOn && settled !== "hold") {
        const paid = await payOne(wallet);
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

    const remaining = state.windowStart + DAY_MS - Date.now();
    const plan = pace({ balance: wallet, remainingMs: remaining, reserve: RESERVE, feePerTx: state.feePerTx });
    if (plan.tpsMilli === 0n || plan.pack === 0 || wallet < BLOCK_FEE + RESERVE) {
      console.log("Holding the payout reserve. Balance", kta(balance), "KTA.");
      await sleep(60000);
      continue;
    }

    if (await finishSignedBlock()) continue;

    const started = Date.now();
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
    const quotes = await client.getQuotes(built.blocks);
    const total = quotes.map(feeSum).filter((fee) => fee > 0n).reduce((sum, fee) => sum + fee, 0n);
    const judged = judgeQuote({
      quote: total,
      ops: BigInt(ops),
      spendable: plan.spendable,
      feePerTx: state.feePerTx,
    });
    if (!judged.ok) {
      state.feePerTx = judged.learn;
      writeState(state);
      console.log(judged.reason === "reserve" ? "Quote would spend the payout reserve. Quote" : "Skip. Quote", kta(total), "KTA. Ops", ops);
      await sleep(judged.reason === "climb" ? 5000 : 30000);
      continue;
    }
    state.feePerTx = judged.learn;

    const before = await client.balance(base);
    const result = await client.publishBuilder(builder);
    const after = await client.balance(base);
    const drop = before > after ? before - after : total;
    state.spent += drop;
    writeState(state);
    notePublished(books, drop, Date.now());
    saveBooks(books);
    const elapsed = Date.now() - started;
    console.log(
      "Published",
      result.publish === true || Boolean(result.voteStaple),
      "pace",
      (Number(plan.tpsMilli) / 1000).toFixed(2),
      "spent",
      kta(state.spent),
      "KTA",
      "left",
      kta(after),
      "cycle",
      (elapsed / 1000).toFixed(1),
      "s",
    );

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
    if (elapsed < plan.intervalMs) await sleep(plan.intervalMs - elapsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("Retry.", message);
    if (message.includes("existing vote for a successor")) {
      try {
        await finishSignedBlock();
      } catch (recoverErr) {
        console.error("Recover failed.", recoverErr instanceof Error ? recoverErr.message : "unknown");
      }
    }
    await sleep(10000);
  }
}

console.log("Stopped.");
await client.destroy?.();
