import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { ALICE, aliceDue, makeBooks, makeClient, readState, runCase, votesFor } from "./fee-harness.mjs";
import { applyPaid } from "./pay.mjs";
import { UNIT, createShare, due } from "./share.mjs";
import { createBooks } from "./books.mjs";
import { startMs } from "./ledger.mjs";

const start = Date.parse("2026-10-18T15:00:00.000Z");
const W = "keeta_w";
const MISSED = "KORE send did not land. Nothing was marked paid. Payout stays queued.";
const VOTE_CAP = "ALERT Fee 0.03000 KTA is over the 0.02000 KTA cap. Backing off.";
const ZERO_CAP = "ALERT Fee 0.00100 KTA is over the 0.00000 KTA cap. Backing off.";
let passed = 0;
let sdkRan = false;

function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function alerts(errors) {
  return errors.filter((line) => line.startsWith("ALERT "));
}

function stateOf(extra = {}) {
  return {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
    payoutFeeDay: "2026-10-18",
    payoutFeeSpent: "0",
    ...extra,
  };
}

function blockOf(hash, operations, date = new Date(start)) {
  return { hash: { toString() { return hash; } }, date, operations };
}

function acct(id) {
  return { id, publicKeyString: { get() { return id; }, toString() { return id; } } };
}

function koreOp(amount, extra = {}) {
  return {
    type: 0,
    to: { id: "dest" },
    amount,
    token: { id: "kore" },
    external: "kore-alice",
    ...extra,
  };
}

function walletBooks(counted = 124378n, paid = 104121n) {
  const books = createBooks(startMs, fromKta("10"));
  books.share.pending.set(W, counted * UNIT);
  books.share.paid.set(W, paid);
  return books;
}

function shareOf(counted, paid) {
  const share = createShare(startMs);
  share.pending.set(W, counted * UNIT);
  share.paid.set(W, paid);
  return share;
}

const saved = {
  picks: process.env.PICKS_OFF,
  fee: process.env.FEE_CAP_PER_BUNDLE_KTA,
  cap: process.env.PAYOUT_FEE_CAP_KTA,
  budget: process.env.PAYOUT_FEE_BUDGET_KTA_PER_DAY,
};

function setEnv(env) {
  const write = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  write("PICKS_OFF", env.picks);
  write("FEE_CAP_PER_BUNDLE_KTA", env.fee);
  write("PAYOUT_FEE_CAP_KTA", env.cap);
  write("PAYOUT_FEE_BUDGET_KTA_PER_DAY", env.budget);
}

async function loadSdk() {
  const file = "/tmp/keeta-0188/node_modules/@keetanetwork/keetanet-client/client/index.js";
  const attempts = ["@keetanetwork/keetanet-client", file];
  for (const spec of attempts) {
    try {
      const mod = await import(spec);
      let version = "";
      try {
        if (spec.startsWith("@")) version = createRequire(import.meta.url)(`${spec}/package.json`).version;
        else version = JSON.parse(readFileSync("/tmp/keeta-0188/node_modules/@keetanetwork/keetanet-client/package.json", "utf8")).version;
      } catch { version = ""; }
      if (version === "0.18.8") return mod.default ?? mod;
    } catch { /* try the next place */ }
  }
  return null;
}

try {
  const dueBooks = makeBooks(true);
  const alice = aliceDue(dueBooks);
  const intent = { from: ALICE, amount: alice.toString(), key: "kore-alice", floor: "1000000" };

  setEnv({ picks: "1", fee: "0.01" });
  const shaped = await runCase({
    books: dueBooks,
    client: makeClient(dueBooks, {
      payoutQuote: fromKta("0.02"),
      pickQuote: fromKta("0.006"),
      voteFee: fromKta("0.02"),
      pending: blockOf("pay-real", [koreOp(alice)]),
    }),
    steps: 0,
    clock: start,
    intent,
    state: stateOf(),
  });
  const shapedState = readState(shaped.dir);
  const published = shaped.logs.find((line) => line.startsWith("Published "));
  check("a real pending block recovers the matching payout", shaped.client.publishes.some((row) => row.kind === "recover") && shaped.client.publishes.length === 1, shaped.client.publishes.map((row) => row.kind).join(","));
  check("a real pending block uses the payout cap and records the fee", shaped.logs.includes("Payout fee 0.02000 KTA. Today 0.02000 KTA.") && shapedState.payoutFeeSpent === fromKta("0.02").toString(), `${shapedState.payoutFeeSpent}\n${shaped.errors.join("\n")}`);
  check("a recovered block logs Published true", published?.startsWith("Published true "), published ?? shaped.logs.join("\n"));

  setEnv({ picks: "1" });
  const bare = await runCase({
    books: makeBooks(true),
    client: makeClient(makeBooks(true), {
      pending: blockOf("bare", [koreOp(alice)]),
    }),
    steps: 1,
    clock: start,
    state: stateOf(),
  });
  check("a KORE send with no intent is not recovered", bare.client.publishes.length === 0 && bare.client.recoverCalls === 0, String(bare.client.recoverCalls));

  const mismatches = [
    ["wrong recipient", koreOp(alice, { to: { id: "other" } })],
    ["wrong amount", koreOp(alice + 1n)],
    ["wrong token", koreOp(alice, { token: { id: "base" } })],
    ["wrong external", koreOp(alice, { external: "nope" })],
    ["no type", (() => { const op = koreOp(alice); delete op.type; return op; })()],
  ];
  for (const [name, op] of mismatches) {
    const ran = await runCase({
      books: makeBooks(true),
      client: makeClient(makeBooks(true), { pending: blockOf(name, [op]) }),
      steps: 1,
      clock: start,
      intent,
      state: stateOf(),
    });
    check(`a pending payout with ${name} publishes nothing`, ran.client.publishes.length === 0 && ran.client.recoverCalls === 0, `${ran.client.recoverCalls}\n${ran.logs.filter((line) => line.startsWith("Published") || line.startsWith("Payout")).join("\n")}`);
  }

  const toA = acct("dest");
  const toB = acct("dest");
  const tokenA = acct("kore");
  const tokenB = acct("kore");
  check("the recipient and token are distinct objects", toA !== toB && tokenA !== tokenB);
  const distinct = await runCase({
    books: dueBooks,
    client: makeClient(dueBooks, {
      payoutQuote: fromKta("0.02"),
      voteFee: fromKta("0.02"),
      pending: blockOf("distinct", [{ type: 0, to: toA, token: tokenB, amount: alice, external: "kore-alice" }]),
    }),
    steps: 0,
    clock: start,
    intent,
    state: stateOf(),
    accountFrom: () => toB,
    koreAccount: tokenA,
  });
  check("distinct account objects still match the payout", distinct.client.publishes.some((row) => row.kind === "recover"), distinct.errors.join("\n"));

  setEnv({ picks: "1" });
  const floor = 1_000_000n;
  const oldAmount = 17307n;
  const missedBooks = walletBooks();
  const missed = await runCase({
    books: missedBooks,
    client: makeClient(missedBooks, {
      koreBal: floor + oldAmount,
      pending: blockOf("old-pick", [{ type: 0, to: { id: "dust" }, amount: 1n, token: { id: "base" }, external: "pick" }], new Date(start - 7 * 60 * 1000)),
    }),
    steps: 1,
    clock: start,
    send: false,
    intent: { from: W, amount: oldAmount.toString(), key: `kore-${W}-121428`, floor: floor.toString() },
    state: stateOf(),
  });
  check("an expired missed payout is not marked done", !readState(missed.dir).done.includes(W) && !existsSync(join(missed.dir, "payout-intent.json")) && !existsSync(join(missed.dir, "PAYHOLD")), JSON.stringify(readState(missed.dir).done));
  check("an expired missed payout stays queued", missed.logs.includes(MISSED) && due(missedBooks.share, W) === 20257n, missed.logs.filter((line) => line.includes("KORE")).join("\n"));

  const freshBooks = walletBooks();
  let freshIntent = null;
  const fresh = await runCase({
    books: freshBooks,
    client: makeClient(freshBooks, {
      koreBal: floor + oldAmount,
      payoutQuote: fromKta("0.00404"),
      pickQuote: fromKta("0.006"),
      pending: blockOf("stale", [{ type: 0, to: { id: "dust" }, amount: 1n, token: { id: "base" }, external: "pick" }], new Date(start - 7 * 60 * 1000)),
    }),
    steps: 1,
    clock: start,
    send: true,
    intent: { from: W, amount: oldAmount.toString(), key: `kore-${W}-121428`, floor: floor.toString() },
    state: stateOf(),
    prepare({ dir, client }) {
      const orig = client.publishBuilder.bind(client);
      client.publishBuilder = async (builder, options) => {
        try { freshIntent = JSON.parse(readFileSync(join(dir, "payout-intent.json"), "utf8")); } catch { freshIntent = null; }
        return orig(builder, options);
      };
    },
  });
  check("a retry after accrual uses the current due and count", freshIntent?.amount === "20257" && freshIntent?.key === `kore-${W}-124378` && freshIntent.amount !== oldAmount.toString() && freshIntent.key !== `kore-${W}-121428`, JSON.stringify(freshIntent));
  check("the accrued retry does not reuse the old amount", fresh.client.publishes.filter((row) => row.kind === "payout").length === 1 && fresh.client.publishes.find((row) => row.kind === "payout")?.amount === 20257n, fresh.client.publishes.map((row) => `${row.kind}:${row.amount ?? ""}`).join(","));

  const landedBooks = walletBooks();
  const landed = await runCase({
    books: landedBooks,
    client: makeClient(landedBooks, { koreBal: 500n, payoutQuote: fromKta("0.00404"), pickQuote: fromKta("0.006") }),
    steps: 2,
    clock: start,
    send: true,
    intent: { from: W, amount: "17307", key: `kore-${W}-121428`, floor: "500" },
    state: stateOf(),
  });
  const paidLines = landed.logs.filter((line) => line.startsWith("Paid "));
  check("a landed payout is marked once", paidLines.length === 1 && paidLines[0] === `Paid 17307 KORE to ${W}` && !existsSync(join(landed.dir, "PAYHOLD")), paidLines.join("\n"));
  check("a landed payout is not sent again the same day", landed.client.publishes.every((row) => row.kind !== "payout"), landed.client.publishes.map((row) => row.kind).join(","));

  setEnv({ picks: "1" });
  const tight = await runCase({
    books: makeBooks(true),
    client: (() => {
      const client = makeClient(makeBooks(true), {
        payoutQuote: fromKta("0.01"),
        pickQuote: fromKta("0.006"),
        customVotes: ({ payout }) => votesFor(payout ? fromKta("0.03") : fromKta("0.006")),
      });
      client.getQuotes = async (blocks) => (blocks ?? []).map((block) => {
        const payout = (block?.operations ?? []).some((op) => op.token?.id === "kore");
        return { fee: { amount: payout ? fromKta("0.01") : fromKta("0.006") } };
      });
      return client;
    })(),
    send: true,
    steps: 1,
    clock: start,
    state: stateOf({ payoutFeeSpent: fromKta("0.48").toString() }),
  });
  check("a 0.03 vote is refused by the 0.02 room", tight.client.publishes.length === 0 && alerts(tight.errors)[0] === VOTE_CAP && !readState(tight.dir).done.includes(ALICE), alerts(tight.errors).join("\n"));

  const small = await runCase({
    books: makeBooks(true),
    client: makeClient(makeBooks(true), { payoutQuote: fromKta("0.01"), pickQuote: fromKta("0.006"), voteFee: fromKta("0.01") }),
    send: true,
    steps: 1,
    clock: start,
    state: stateOf({ payoutFeeSpent: fromKta("0.48").toString() }),
  });
  check("a 0.01 vote publishes inside the room", small.client.publishes.some((row) => row.kind === "payout") && readState(small.dir).payoutFeeSpent === fromKta("0.49").toString(), `${readState(small.dir).payoutFeeSpent}\n${alerts(small.errors).join("\n")}`);

  const zeroBooks = makeBooks(true);
  const zeroClient = makeClient(zeroBooks, {
    payoutQuote: 0n,
    pickQuote: fromKta("0.006"),
    customVotes: ({ payout }) => votesFor(payout ? fromKta("0.001") : fromKta("0.006")),
  });
  zeroClient.getQuotes = async () => [{ fee: { amount: 0n } }];
  const zeroCap = await runCase({
    books: zeroBooks,
    client: zeroClient,
    send: true,
    steps: 1,
    clock: start,
    state: stateOf({ payoutFeeSpent: fromKta("0.5").toString() }),
  });
  check("a used-up budget refuses a 0.001 vote at cap 0", zeroCap.client.publishes.length === 0 && alerts(zeroCap.errors)[0] === ZERO_CAP, alerts(zeroCap.errors).join("\n") || zeroCap.logs.join("\n"));

  const freeBooks = makeBooks(true);
  const freeClient = makeClient(freeBooks, {
    payoutQuote: 0n,
    pickQuote: fromKta("0.006"),
    customVotes: ({ payout }) => votesFor(payout ? 0n : fromKta("0.006")),
  });
  freeClient.getQuotes = async () => [{ fee: { amount: 0n } }];
  const freeVote = await runCase({
    books: freeBooks,
    client: freeClient,
    send: true,
    steps: 1,
    clock: start,
    state: stateOf({ payoutFeeSpent: fromKta("0.5").toString() }),
  });
  check("an all-zero vote publishes when the budget is used up", freeVote.client.publishes.some((row) => row.kind === "payout") && readState(freeVote.dir).payoutFeeSpent === fromKta("0.5").toString(), `${readState(freeVote.dir).payoutFeeSpent}\n${alerts(freeVote.errors).join("\n")}\n${freeVote.logs.filter((line) => line.startsWith("Payout") || line.startsWith("Published") || line.startsWith("Skip")).join("\n")}`);

  const recRefuseBooks = walletBooks();
  const recRefuse = await runCase({
    books: recRefuseBooks,
    client: (() => {
      const client = makeClient(recRefuseBooks, {
        voteFee: fromKta("0.001"),
        payoutQuote: 0n,
        pending: blockOf("cap0", [koreOp(17307n, { external: `kore-${W}-121428`, to: acct("dest") })]),
      });
      client.getQuotes = async () => [{ fee: { amount: 0n } }];
      return client;
    })(),
    steps: 0,
    clock: start,
    intent: { from: W, amount: "17307", key: `kore-${W}-121428`, floor: "1000000" },
    state: stateOf({ payoutFeeSpent: fromKta("0.5").toString() }),
    accountFrom: () => acct("dest"),
  });
  check("a recovered payout refuses a 0.001 vote at cap 0", recRefuse.client.publishes.length === 0 && alerts(recRefuse.errors)[0] === ZERO_CAP, alerts(recRefuse.errors).join("\n") || recRefuse.logs.join("\n"));

  const recFree = await runCase({
    books: walletBooks(),
    client: (() => {
      const client = makeClient(walletBooks(), {
        voteFee: 0n,
        payoutQuote: 0n,
        pending: blockOf("free-rec", [koreOp(17307n, { external: `kore-${W}-121428` })]),
      });
      client.getQuotes = async () => [{ fee: { amount: 0n } }];
      return client;
    })(),
    steps: 0,
    clock: start,
    intent: { from: W, amount: "17307", key: `kore-${W}-121428`, floor: "1000000" },
    state: stateOf({ payoutFeeSpent: fromKta("0.5").toString() }),
  });
  check("a recovered all-zero vote publishes when the budget is used up", recFree.client.publishes.some((row) => row.kind === "recover") && recFree.logs.includes("Payout fee 0.00000 KTA. Today 0.50000 KTA.") && readState(recFree.dir).payoutFeeSpent === fromKta("0.5").toString(), `${readState(recFree.dir).payoutFeeSpent}\n${recFree.errors.join("\n")}`);

  const marked = shareOf(124378n, 104121n);
  const markIntent = { from: W, amount: "17307", key: `kore-${W}-121428` };
  check("applyPaid marks the 17307 remainder", applyPaid(marked, markIntent) === "marked" && marked.paid.get(W) === 121428n && due(marked, W) === 2950n, `${marked.paid.get(W)} due ${due(marked, W)}`);
  check("applyPaid does not add a payout that is already recorded", applyPaid(marked, markIntent) === "done" && marked.paid.get(W) === 121428n);

  const drifted = shareOf(124378n, 100000n);
  check("applyPaid halts when the count and the amount disagree", applyPaid(drifted, markIntent) === "halt" && drifted.paid.get(W) === 100000n);

  const short = shareOf(110000n, 104121n);
  check("applyPaid halts when the books owe less than the intent", applyPaid(short, { from: W, amount: "17307", key: `kore-${W}-121428` }) === "halt" && due(short, W) === 5879n && short.paid.get(W) === 104121n);

  const badKey = shareOf(124378n, 104121n);
  check("applyPaid halts on a malformed key", applyPaid(badKey, { from: W, amount: "17307", key: "kore-not-a-count" }) === "halt");
  check("applyPaid halts when the key names another wallet", applyPaid(badKey, { from: W, amount: "17307", key: "kore-keeta_other-121428" }) === "halt" && badKey.paid.get(W) === 104121n);

  const quiet = await runCase({
    books: dueBooks,
    client: (() => {
      const client = makeClient(dueBooks, {
        payoutQuote: fromKta("0.02"),
        voteFee: fromKta("0.02"),
        pending: blockOf("null-rec", [koreOp(alice)]),
      });
      client.recover = async () => {
        client.recoverCalls += 1;
        return null;
      };
      return client;
    })(),
    steps: 0,
    clock: start,
    intent,
    state: stateOf(),
  });
  check("a null recover adds no fee and prints no Published line", quiet.client.recoverCalls === 1 && !quiet.logs.some((line) => line.startsWith("Payout fee ")) && !quiet.logs.some((line) => line.startsWith("Published ")) && readState(quiet.dir).payoutFeeSpent === "0", quiet.logs.filter((line) => line.startsWith("Payout") || line.startsWith("Published")).join("\n"));

  const unknown = await runCase({
    books: dueBooks,
    client: (() => {
      const client = makeClient(dueBooks, {
        pending: blockOf("unknown-fee", [koreOp(alice)]),
      });
      client.getQuotes = async () => { throw new Error("quotes down"); };
      client.recover = async () => {
        client.recoverCalls += 1;
        client.publishes.push({ kind: "recover" });
        client.pending = null;
        return { blocks: [], votes: [] };
      };
      return client;
    })(),
    steps: 0,
    clock: start,
    intent,
    state: stateOf(),
  });
  check("an unknown fee is charged at the vote cap", unknown.client.feeBlockBuilds === 0 && unknown.logs.includes("Payout fee 0.05000 KTA. Today 0.05000 KTA.") && readState(unknown.dir).payoutFeeSpent === fromKta("0.05").toString(), `${readState(unknown.dir).payoutFeeSpent}\n${unknown.errors.join("\n")}\n${unknown.logs.filter((line) => line.startsWith("Payout") || line.startsWith("ALERT")).join("\n")}`);

  const stapled = await runCase({
    books: dueBooks,
    client: (() => {
      const client = makeClient(dueBooks, {
        payoutQuote: fromKta("0.01"),
        pending: blockOf("staple-fee", [koreOp(alice)]),
      });
      client.getQuotes = async () => [{ fee: { amount: fromKta("0.01") } }];
      client.recover = async () => {
        client.recoverCalls += 1;
        client.publishes.push({ kind: "recover" });
        client.pending = null;
        return {
          blocks: [{ operations: [{ type: 0, amount: fromKta("0.02"), token: { id: "base" } }] }],
          votes: [],
        };
      };
      return client;
    })(),
    steps: 0,
    clock: start,
    intent,
    state: stateOf(),
  });
  check("a staple fee block is what gets recorded", stapled.client.feeBlockBuilds === 0 && stapled.logs.includes("Payout fee 0.02000 KTA. Today 0.02000 KTA.") && readState(stapled.dir).payoutFeeSpent === fromKta("0.02").toString(), `${readState(stapled.dir).payoutFeeSpent}\n${stapled.logs.filter((line) => line.startsWith("Payout")).join("\n")}`);

  const sdk = await loadSdk();
  if (!sdk?.lib?.Block || !sdk?.lib?.Account) {
    check("real SDK block case skipped", true);
  } else {
    sdkRan = true;
    const { Account, Block } = sdk.lib;
    const miner = Account.fromSeed(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), 0);
    const dest = Account.fromSeed(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), 0);
    const kore = Account.fromPublicKeyString("keeta_apu6efya45r6rirjwyhl25djcuqg53zlepwctj7xpzvmrhfwckrzxwht4sypk");
    const sdkKey = `kore-${dest.publicKeyString.get()}-1`;
    const sdkAmount = 17307n;
    const sdkBlock = await new Block.Builder({
      account: miner,
      network: 0x5382n,
      previous: Block.getAccountOpeningHash(miner),
      operations: [{
        type: Block.OperationType.SEND,
        to: dest,
        amount: sdkAmount,
        token: kore,
        external: sdkKey,
      }],
    }).seal();
    setEnv({ picks: "1", fee: "0.01" });
    const sdkBooks = makeBooks(false);
    const sdkRanCase = await runCase({
      books: sdkBooks,
      client: makeClient(sdkBooks, {
        payoutQuote: fromKta("0.02"),
        pickQuote: fromKta("0.006"),
        voteFee: fromKta("0.02"),
        pending: sdkBlock,
      }),
      steps: 0,
      clock: Date.now(),
      intent: { from: dest.publicKeyString.get(), amount: sdkAmount.toString(), key: sdkKey, floor: "1000000" },
      state: {
        ...stateOf(),
        windowStart: Date.now(),
        payoutDay: new Date().toISOString().slice(0, 10),
        payoutFeeDay: new Date().toISOString().slice(0, 10),
      },
      accountFrom: () => dest,
      koreAccount: kore,
    });
    const sdkLine = sdkRanCase.logs.find((line) => line.startsWith("Published "));
    check("a sealed SDK block recovers through the same check", sdkRanCase.client.publishes.some((row) => row.kind === "recover") && sdkRanCase.logs.includes("Payout fee 0.02000 KTA. Today 0.02000 KTA.") && sdkLine?.startsWith("Published true ") && readState(sdkRanCase.dir).payoutFeeSpent === fromKta("0.02").toString(), `${readState(sdkRanCase.dir).payoutFeeSpent}\n${sdkLine ?? ""}\n${sdkRanCase.errors.join("\n")}\n${sdkRanCase.logs.filter((line) => line.startsWith("Picks") || line.startsWith("Leaving") || line.startsWith("Finishing") || line.startsWith("Payout") || line.startsWith("Published")).join("\n")}`);
  }
} finally {
  setEnv(saved);
}

console.log("fee-block checks", passed);
console.log(sdkRan ? "sdk block case ran" : "sdk block case skipped");
