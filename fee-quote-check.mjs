import { existsSync } from "node:fs";
import { join } from "node:path";
import { FEE_PER_TX, fromKta } from "./pace.mjs";
import { makeBooks, makeClient, runCase } from "./fee-harness.mjs";

const PICK_ALERT = "ALERT Fee 3.00300 KTA is over the 0.05000 KTA cap. Picks paused (FEEHOLD). Ask Keeta before removing FEEHOLD.";
const PAY_ALERT = "ALERT Payout fee 3.00300 KTA is over the 0.05000 KTA payout cap. Payout stays queued.";
let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function alerts(errors) {
  return errors.filter((line) => line.startsWith("ALERT "));
}

async function overQuote(kind) {
  const books = makeBooks(kind === "payout");
  const client = makeClient(books, {
    pickQuote: fromKta("3.003"),
    payoutQuote: fromKta("3.003"),
    voteFee: fromKta("3.003"),
  });
  if (kind === "payout") process.env.PICKS_OFF = "1";
  let raised = false;
  let ran;
  try {
    ran = await runCase({
      books,
      client,
      send: kind === "payout",
      steps: 3,
      state: kind === "payout" ? {
        windowStart: Date.parse("2026-10-18T15:00:00.000Z"),
        spent: "0",
        feePerTx: FEE_PER_TX.toString(),
        payoutDay: "2026-10-18",
        done: [],
        closeOpen: true,
      } : null,
      onSleep({ client: live }) {
        if (!raised) {
          raised = true;
          live.pickQuote = fromKta("6");
          live.payoutQuote = fromKta("6");
          live.voteFee = fromKta("6");
        }
      },
    });
  } finally {
    if (kind === "payout") delete process.env.PICKS_OFF;
  }
  const seen = alerts(ran.errors);
  if (kind === "payout") {
    check("a payout quote of 3.003 then 6 stays queued", seen[0] === PAY_ALERT && seen.every((line) => line.startsWith("ALERT Payout fee ")), seen.join("\n"));
    check("a payout over-cap quote backs off", ran.sleeps[0] === 30_000, ran.sleeps.join(","));
    check("a payout over-cap quote publishes nothing", ran.client.publishes.length === 0, String(ran.client.publishes.length));
    check("a payout over-cap quote is not a plain skip", !ran.logs.some((line) => line.startsWith("Skip KORE. Quote")));
    return;
  }
  check(`a ${kind} quote of 3.003 then 6 alerts once`, seen.length === 1 && seen[0] === PICK_ALERT, seen.join("\n"));
  // fix/rate-hold: the first pick quote is the pre-start fee check. Over the cap it prints SKIP, writes FEEHOLD and holds (no backoff ladder).
  check(`a ${kind} over-cap quote skips the start and holds`, ran.logs.includes("SKIP: fee 3.00300 KTA a block is over the 0.05000 KTA cap. Picks not started.") && existsSync(join(ran.dir, "FEEHOLD")) && ran.sleeps.every((ms) => ms === 30_000), ran.sleeps.join(",") + "\n" + ran.logs.join("\n"));
  check(`a ${kind} over-cap quote publishes nothing`, ran.client.publishes.length === 0, String(ran.client.publishes.length));
  check(`a ${kind} over-cap quote is not a plain skip`, !ran.logs.some((line) => line.startsWith("Skip. Quote") || line.startsWith("Skip KORE. Quote")));
}

await overQuote("pick");
await overQuote("payout");
console.log("fee-quote checks", passed);
