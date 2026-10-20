import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BLOCK_FEE, DAY_MS, FEE_PER_TX, FeeOverCap, bundleCap, judgeQuote, kta, pace, voteFeeTotal } from "./pace.mjs";
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

function feeSum(quote) {
  if (!quote?.fee) return 0n;
  const fees = Array.isArray(quote.fee) ? quote.fee : [quote.fee];
  return fees.reduce((sum, fee) => sum + BigInt(fee.amount), 0n);
}

function quotesFee(quotes) {
  return (quotes ?? []).map(feeSum).filter((item) => item > 0n).reduce((sum, item) => sum + item, 0n);
}

function isOverCap(err) {
  return err instanceof FeeOverCap || err?.name === "FeeOverCap";
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

  function armEpisode(err) {
    const first = overCapStep === null;
    if (first) {
      overCapStep = 0;
      const fee = err?.fee ?? 0n;
      const cap = err?.cap ?? bundleCap();
      console.error(`ALERT Fee ${kta(fee)} KTA is over the ${kta(cap)} KTA cap. Backing off.`);
    }
    const delay = Math.min(30_000 * 2 ** overCapStep, 600_000);
    overCapStep += 1;
    return delay;
  }

  function clearEpisode() {
    overCapStep = null;
  }

  function cappedFeeBlock() {
    return async (staple) => {
      const fee = voteFeeTotal(staple);
      const cap = bundleCap();
      if (fee > cap) throw new FeeOverCap(fee, cap);
      const builder = client.initBuilder();
      return builder.computeFeeBlock(staple);
    };
  }

  async function publishCapped(builder, quotes) {
    const quoted = quotesFee(quotes);
    const cap = bundleCap();
    if (quoted > cap) throw new FeeOverCap(quoted, cap);
    return client.publishBuilder(builder, { generateFeeBlock: cappedFeeBlock(), quotes });
  }

  function clampFeePerTx(value) {
    let fee = FEE_PER_TX;
    try { fee = BigInt(value ?? FEE_PER_TX); } catch { return FEE_PER_TX; }
    if (fee <= 0n || fee > bundleCap() / 50n) return FEE_PER_TX;
    return fee;
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
      };
    } catch {
      return { windowStart: now(), spent: 0n, feePerTx: FEE_PER_TX, payoutDay: "", done: [], closeOpen: false };
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
    });
    writeFileSync(`${statePath}.tmp`, body);
    renameSync(`${statePath}.tmp`, statePath);
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
  const books = loadBooks();
  writeState(state);
  let blockNo = 0;
  let koreStart = koreStartIn === null ? await client.balance(kore) : koreStartIn;

  function blockTime(pending) {
    const when = pending.date instanceof Date ? pending.date.getTime() : Date.parse(String(pending.date));
    return when;
  }

  async function finishSignedBlock() {
    const pending = await client.pendingBlock();
    if (!pending) return false;
    console.log("Finishing the block already signed.");
    const when = blockTime(pending);
    if (Number.isFinite(when) && now() - when > 6 * 60 * 1000) {
      console.log("Leaving the expired block. It cannot gather enough votes.");
      return "expired";
    }
    try {
      const blocks = Array.isArray(pending.blocks) ? pending.blocks : [];
      let quotes;
      if (blocks.length > 0 && typeof client.getQuotes === "function") quotes = await client.getQuotes(blocks);
      const quoted = quotesFee(quotes);
      const cap = bundleCap();
      if (quoted > cap) throw new FeeOverCap(quoted, cap);
      await client.recover(true, { generateFeeBlock: cappedFeeBlock(), quotes });
      clearEpisode();
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
    if (judgeIntent(koreBal, intent) === "paid") {
      if (settlePayout(koreBal) === "paid") koreStart = await client.balance(kore);
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
    } else {
      console.error("Recover failed.", err instanceof Error ? err.message : "unknown");
    }
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
    const quotes = await client.getQuotes(built.blocks);
    const fee = quotesFee(quotes);
    const spendable = wallet > RESERVE ? wallet - RESERVE : 0n;
    const judged = judgeQuote({ quote: fee, ops: 1n, spendable, feePerTx: state.feePerTx ?? FEE_PER_TX });
    if (!judged.ok) {
      if (judged.reason !== "cap") {
        state.done = Array.isArray(state.done) ? state.done : [];
        if (!state.done.includes(row.from)) state.done.push(row.from);
      }
      writeState(state);
      console.log(judged.reason === "reserve" ? "KORE waiting. Fee would spend the reserve." : "Skip KORE. Quote", kta(fee), "KTA.");
      return "skip";
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
      await publishCapped(builder, quotes);
      clearEpisode();
    } catch (err) {
      if (isOverCap(err)) {
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
  while (!existsSync(`${dir}/STOP`)) {
    if (ran >= steps) break;
    ran += 1;
    try {
      if (now() - state.windowStart >= DAY_MS) {
        state = {
          windowStart: now(),
          spent: 0n,
          feePerTx: clampFeePerTx(state.feePerTx ?? FEE_PER_TX),
          payoutDay: state.payoutDay ?? "",
          done: state.done ?? [],
          closeOpen: state.closeOpen === true,
        };
        writeState(state);
        console.log("New day. Pace window reset.");
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
      if (gate === true || gate === "wait") {
        if (gate === "wait") await sleep(10000);
        continue;
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

      const remaining = state.windowStart + DAY_MS - now();
      const plan = pace({ balance: wallet, remainingMs: remaining, reserve: RESERVE, feePerTx: state.feePerTx });
      if (plan.tpsMilli === 0n || plan.pack === 0 || wallet < BLOCK_FEE + RESERVE) {
        console.log("Holding the payout reserve. Balance", kta(balance), "KTA.");
        await sleep(60000);
        continue;
      }

      const again = await finishSignedBlock();
      if (again === "expired") await settleExpiredIntent();
      if (again === true || again === "wait") {
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
      const quotes = await client.getQuotes(built.blocks);
      const total = quotesFee(quotes);
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
        await sleep(30000);
        continue;
      }
      state.feePerTx = judged.learn;

      const before = await client.balance(base);
      const result = await publishCapped(builder, quotes);
      clearEpisode();
      const after = await client.balance(base);
      const drop = before > after ? before - after : total;
      state.spent += drop;
      writeState(state);
      notePublished(books, drop, now());
      saveBooks(books);
      const elapsed = now() - started;
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
      if (isOverCap(err)) {
        const delay = armEpisode(err);
        await sleep(delay);
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

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
