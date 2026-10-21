import { existsSync } from "node:fs";
import { join } from "node:path";
import { createBooks, ingest } from "./books.mjs";
import { startMs } from "./ledger.mjs";
import { due } from "./share.mjs";
import { configLine, fromKta, payoutFeeBudget, payoutFeeCap } from "./pace.mjs";
import { ALICE, makeBooks, makeClient, readState, runCase } from "./fee-harness.mjs";
import { FEE_PER_TX } from "./pace.mjs";

const start = Date.parse("2026-10-18T15:00:00.000Z");
const CAP_ALERT = "ALERT Payout fee 0.06000 KTA is over the 0.05000 KTA payout cap. Payout stays queued.";
const BUDGET_ALERT = "ALERT Payout fee budget for today is used up (0.00404 of 0.00404 KTA). Payouts wait until the next UTC day.";
const EXAMPLE = "Config fee cap 0.05000 KTA. Payout fee cap 0.05000 KTA. Payout fee budget 0.50000 KTA a day. Max 60 blocks an hour. (clamped from payout cap 5.00000 KTA, payout budget 80.00000 KTA) Hard limits 0.05000 KTA a block, 60 ledger blocks an hour, payout 0.05000 KTA a block and 0.50000 KTA a day. Picks off.";
let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

const saved = {
  cap: process.env.PAYOUT_FEE_CAP_KTA,
  budget: process.env.PAYOUT_FEE_BUDGET_KTA_PER_DAY,
  picks: process.env.PICKS_OFF,
  fee: process.env.FEE_CAP_PER_BUNDLE_KTA,
};

function setEnv(env) {
  const write = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  write("PAYOUT_FEE_CAP_KTA", env.cap);
  write("PAYOUT_FEE_BUDGET_KTA_PER_DAY", env.budget);
  write("PICKS_OFF", env.picks ?? "0"); // r2: unset now means off, so picks-on tests say 0
  write("FEE_CAP_PER_BUNDLE_KTA", env.fee);
}

function payoutState(extra = {}) {
  return {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
    ...extra,
  };
}

function crowd() {
  const books = createBooks(startMs, fromKta("30"));
  ingest(books, {
    blocksHash: "deps",
    timeMs: startMs + 1000,
    deposits: [
      { from: ALICE, amount: fromKta("20") },
      { from: "keeta_bob", amount: fromKta("10") },
    ],
    ownPicks: 0,
  });
  ingest(books, {
    blocksHash: "roll-day",
    timeMs: startMs + 86_400_000 + 1000,
    deposits: [],
    ownPicks: 0,
  });
  return books;
}

try {
  setEnv({});
  check("the payout cap defaults to 0.05", payoutFeeCap() === fromKta("0.05"));
  check("the payout budget defaults to 0.5", payoutFeeBudget() === fromKta("0.5"));
  setEnv({ cap: "11", budget: "150" });
  // fix/rate-hold: hard payout ceilings at today's values, 0.05 KTA a block and 0.5 KTA a day.
  check("a payout cap of 11 clamps to the hard 0.05", payoutFeeCap() === fromKta("0.05"));
  check("a payout budget of 150 clamps to the hard 0.5", payoutFeeBudget() === fromKta("0.5"));
  check("a clamped payout cap is logged", configLine().includes("Payout fee cap 0.05000 KTA.") && configLine().includes("payout cap 11.00000 KTA") && configLine().includes("payout budget 150.00000 KTA"));
  setEnv({ cap: "0.01", budget: "0.2" });
  check("the env can lower the payout cap and budget", payoutFeeCap() === fromKta("0.01") && payoutFeeBudget() === fromKta("0.2"));
  setEnv({ cap: "nope", budget: "-3" });
  check("a bad payout cap uses the default", payoutFeeCap() === fromKta("0.05"));
  check("a negative payout budget uses the default", payoutFeeBudget() === fromKta("0.5"));
  setEnv({ cap: "0", budget: "0" });
  check("a zero payout cap and budget use the defaults", payoutFeeCap() === fromKta("0.05") && payoutFeeBudget() === fromKta("0.5"));
  setEnv({ cap: "5", budget: "80", picks: "1" });
  check("startup names the payout cap and budget", configLine() === EXAMPLE, configLine());

  setEnv({ cap: "5", budget: "80", picks: "1" });
  const underBooks = makeBooks(true);
  const under = await runCase({
    books: underBooks,
    client: makeClient(underBooks, { payoutQuote: fromKta("0.00404"), pickQuote: fromKta("0.006") }),
    send: true,
    steps: 1,
    clock: start,
    state: payoutState(),
  });
  const underPaid = under.client.publishes.filter((row) => row.kind === "payout");
  const underState = readState(under.dir);
  check("a payout under the cap and budget is published", underPaid.length === 1, under.client.publishes.map((row) => row.kind).join(","));
  check("a published payout records today's fee", under.logs.includes("Payout fee 0.00404 KTA. Today 0.00404 KTA.") && underState.payoutFeeSpent === fromKta("0.00404").toString() && underState.payoutFeeDay === "2026-10-18", JSON.stringify(underState));

  setEnv({ cap: "5", budget: "0.00404", picks: "1" });
  const restarted = { ...underState, done: [] };
  const againBooks = makeBooks(true);
  const again = await runCase({
    books: againBooks,
    client: makeClient(againBooks, { payoutQuote: fromKta("0.00404"), pickQuote: fromKta("0.006"), koreBal: 50_000_000n }),
    send: true,
    steps: 1,
    clock: start,
    state: restarted,
  });
  check("payout fee spend survives a restart", again.client.publishes.every((row) => row.kind !== "payout") && again.errors.includes(BUDGET_ALERT), again.errors.filter((line) => line.startsWith("ALERT ")).join("\n"));
  check("a restart does not drop the queued payout", !readState(again.dir).done.includes(ALICE) && due(again.books.share, ALICE) > 0n);

  setEnv({ picks: "1" });
  const capBooks = makeBooks(true);
  const capped = await runCase({
    books: capBooks,
    client: makeClient(capBooks, { payoutQuote: fromKta("0.06"), pickQuote: fromKta("0.006"), koreBal: 50_000_000n }),
    send: true,
    steps: 1,
    clock: start,
    state: payoutState(),
  });
  check("a payout over the cap is refused", capped.client.publishes.length === 0 && capped.errors.includes(CAP_ALERT), capped.errors.join("\n"));
  check("a payout over the cap stays queued", !readState(capped.dir).done.includes(ALICE) && !existsSync(join(capped.dir, "payout-intent.json")) && due(capped.books.share, ALICE) > 0n, JSON.stringify(readState(capped.dir).done));

  setEnv({ cap: "5", budget: "0.00404", picks: "1" });
  const books = crowd();
  check("two wallets are owed", due(books.share, ALICE) > 0n && due(books.share, "keeta_bob") > 0n);
  let jumped = false;
  let atBlock = -1;
  const shared = await runCase({
    books,
    client: makeClient(books, { payoutQuote: fromKta("0.00404"), pickQuote: fromKta("0.006"), koreBal: 50_000_000n }),
    send: true,
    steps: 4,
    clock: start,
    state: payoutState(),
    onSleep({ sleeps, client, time }) {
      if (!jumped && sleeps[sleeps.length - 1] === 30_000) {
        atBlock = client.publishes.filter((row) => row.kind === "payout").length;
        jumped = true;
        time.t += 24 * 60 * 60 * 1000;
      }
    },
  });
  const payouts = shared.client.publishes.filter((row) => row.kind === "payout");
  check("a used budget blocks the next payout", atBlock === 1 && shared.errors.includes(BUDGET_ALERT), JSON.stringify({ atBlock, alerts: shared.errors.filter((line) => line.startsWith("ALERT ")) }));
  check("payouts resume after the UTC day change", payouts.length === 2 && readState(shared.dir).payoutFeeDay === "2026-10-19" && readState(shared.dir).payoutFeeSpent === fromKta("0.00404").toString(), JSON.stringify({ n: payouts.length, day: readState(shared.dir).payoutFeeDay, spent: readState(shared.dir).payoutFeeSpent }));

  setEnv({ cap: "5" });
  const pickBooks = makeBooks(false);
  const pick = await runCase({
    books: pickBooks,
    client: makeClient(pickBooks, { pickQuote: fromKta("0.06"), voteFee: fromKta("0.06") }),
    steps: 1,
    clock: start,
  });
  check("a 0.06 pick is still refused when the payout cap is 5", pick.client.publishes.length === 0 && pick.client.feeBlockBuilds === 0 && pick.errors.some((line) => line === "ALERT Fee 0.06000 KTA is over the 0.05000 KTA cap. Picks paused (FEEHOLD). Ask Keeta before removing FEEHOLD."), pick.errors.join("\n"));
} finally {
  setEnv(saved);
}

console.log("fee-payout-fee checks", passed);
