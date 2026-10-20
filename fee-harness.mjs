import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounted, booksToJson, createBooks, ingest } from "./books.mjs";
import { startMs } from "./ledger.mjs";
import { due } from "./share.mjs";
import { fromKta } from "./pace.mjs";
import { runShaft } from "./run.mjs";

const DAY = 86_400_000;
export const ALICE = "keeta_alice";
const koreId = "keeta_apu6efya45r6rirjwyhl25djcuqg53zlepwctj7xpzvmrhfwckrzxwht4sypk";

export function votesFor(total) {
  const amount = typeof total === "function" ? total() : total;
  const part = amount / 4n;
  const rest = amount - part * 3n;
  return [part, part, part, rest].map((fee) => ({ fee: { amount: fee } }));
}

export function makeBooks(withDue = false) {
  const open = startMs;
  const books = createBooks(open, fromKta("10"));
  if (withDue) {
    ingest(books, {
      blocksHash: "dep-alice",
      timeMs: open + 1000,
      deposits: [{ from: ALICE, amount: fromKta("20") }],
      ownPicks: 0,
    });
    ingest(books, {
      blocksHash: "roll-day",
      timeMs: open + DAY + 1000,
      deposits: [],
      ownPicks: 0,
    });
  }
  return books;
}

export function makeClient(books, options = {}) {
  const client = {
    baseBal: options.baseBal ?? accounted(books),
    koreBal: options.koreBal ?? 1_000_000n,
    pickQuote: options.pickQuote ?? fromKta("0.006"),
    payoutQuote: options.payoutQuote ?? fromKta("0.00404"),
    voteFee: options.voteFee === undefined ? null : options.voteFee,
    pending: options.pending ?? null,
    publishes: [],
    feeBlockBuilds: 0,
    recoverCalls: 0,
    initBuilder() {
      const builder = {
        ops: [],
        send(to, amount, token, key) { this.ops.push({ to, amount, token, key }); },
        async computeBlocks() {
          if (client.fixedOps) {
            const ops = this.ops.slice(0, client.fixedOps);
            while (ops.length < client.fixedOps) ops.push({ amount: 1n, token: { id: "base" } });
            return { blocks: [{ operations: ops, account: "shaft" }] };
          }
          return { blocks: [{ operations: this.ops.map((op) => ({ ...op })), account: "shaft" }] };
        },
        async computeFeeBlock() {
          client.feeBlockBuilds += 1;
          return { kind: "fee", operations: [] };
        },
      };
      return builder;
    },
    quoteFor(block) {
      const payout = (block?.operations ?? []).some((op) => op.token?.id === "kore");
      return payout ? client.payoutQuote : client.pickQuote;
    },
    voteTotal(payout) {
      const chosen = typeof client.voteFee === "function" ? client.voteFee({ payout }) : client.voteFee;
      if (chosen === null || chosen === undefined) return payout ? client.payoutQuote : client.pickQuote;
      return chosen;
    },
    async getQuotes(blocks) {
      return (blocks ?? []).map((block) => ({ fee: { amount: client.quoteFor(block) } }));
    },
    async getHistory() { return []; },
    async balance(account) {
      if (account === koreId || account?.id === "kore") return client.koreBal;
      return client.baseBal;
    },
    async pendingBlock() { return client.pending; },
    async publishBuilder(builder, options) {
      const payout = builder.ops?.some((op) => op.token?.id === "kore");
      if (options?.generateFeeBlock) await options.generateFeeBlock({ votes: votesFor(client.voteTotal(payout)) });
      if (payout) {
        const amount = BigInt(builder.ops.find((op) => op.token?.id === "kore").amount);
        client.koreBal -= amount;
        client.publishes.push({ kind: "payout", amount });
      } else {
        client.baseBal -= client.pickQuote;
        client.publishes.push({ kind: "pick", ops: builder.ops.length });
      }
      return { publish: true, voteStaple: { ok: true } };
    },
    async recover(publish, options) {
      client.recoverCalls += 1;
      if (client.recoverError) throw client.recoverError;
      if (options?.generateFeeBlock) await options.generateFeeBlock({ votes: votesFor(client.voteTotal(false)) });
      if (publish !== false) {
        client.publishes.push({ kind: "recover" });
        client.pending = null;
      }
      return { publish: true };
    },
  };
  return client;
}

export async function runCase({
  books,
  client,
  send = false,
  state = null,
  intent = null,
  steps = 4,
  clock = Date.parse("2026-10-18T15:00:00.000Z"),
  onSleep = null,
  prepare = null,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kore-fee-"));
  const openBooks = books ?? makeBooks(false);
  writeFileSync(join(dir, "books.json"), JSON.stringify(booksToJson(openBooks)));
  if (send) writeFileSync(join(dir, "SEND"), "on\n");
  if (state) writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  if (intent) writeFileSync(join(dir, "payout-intent.json"), JSON.stringify(intent));
  const time = { t: clock };
  const sleeps = [];
  const logs = [];
  const errors = [];
  const say = console.log;
  const yell = console.error;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args) => { errors.push(args.map(String).join(" ")); };
  const fake = client ?? makeClient(openBooks);
  if (prepare) await prepare({ dir, client: fake, time });
  try {
    await runShaft({
      dir,
      client: fake,
      base: { id: "base" },
      baseText: "base",
      dustAccount: { id: "dust" },
      koreAccount: { id: "kore" },
      accountFrom: () => ({ id: "dest" }),
      now: () => time.t,
      sleep: async (ms) => {
        time.t += ms;
        sleeps.push(ms);
        if (onSleep) await onSleep({ ms, time, sleeps, client: fake, dir });
      },
      steps,
    });
  } finally {
    console.log = say;
    console.error = yell;
  }
  return { dir, client: fake, sleeps, logs, errors, time, books: openBooks };
}

export function readState(dir) {
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

export function aliceDue(books) {
  return due(books.share, ALICE);
}
