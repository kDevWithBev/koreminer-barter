import { FEE_PER_TX, fromKta, maxBlocksPerHour, picksOff } from "./pace.mjs";
import { makeBooks, makeClient, runCase } from "./fee-harness.mjs";

const LINE = "Picks off. Payouts only.";
const start = Date.parse("2026-10-18T15:00:00.000Z");
let passed = 0;
function check(name, ok, extra = "") {
  if (!ok) throw new Error(`${name}${extra ? `\n${extra}` : ""}`);
  passed += 1;
  console.log("ok", name);
}

function notes(logs) {
  return logs.filter((line) => line === LINE);
}

function watch(client) {
  const seen = { pickBuilds: 0, pickQuotes: 0 };
  const origInit = client.initBuilder.bind(client);
  client.initBuilder = () => {
    const builder = origInit();
    const origCompute = builder.computeBlocks.bind(builder);
    builder.computeBlocks = async () => {
      const payout = builder.ops.some((op) => op.token?.id === "kore");
      if (!payout) seen.pickBuilds += 1;
      return origCompute();
    };
    return builder;
  };
  const origQuotes = client.getQuotes.bind(client);
  client.getQuotes = async (blocks) => {
    const payout = (blocks ?? []).some((block) => (block.operations ?? []).some((op) => op.token?.id === "kore"));
    if (!payout) seen.pickQuotes += 1;
    return origQuotes(blocks);
  };
  return seen;
}

function payoutState() {
  return {
    windowStart: start,
    spent: "0",
    feePerTx: FEE_PER_TX.toString(),
    payoutDay: "2026-10-18",
    done: [],
    closeOpen: true,
  };
}

async function withEnv(env, fn) {
  const prevPicks = process.env.PICKS_OFF;
  const prevRate = process.env.MAX_BLOCKS_PER_HOUR;
  if (env.picks === undefined) delete process.env.PICKS_OFF;
  else process.env.PICKS_OFF = env.picks;
  if (env.rate === undefined) delete process.env.MAX_BLOCKS_PER_HOUR;
  else process.env.MAX_BLOCKS_PER_HOUR = env.rate;
  try {
    return await fn();
  } finally {
    if (prevPicks === undefined) delete process.env.PICKS_OFF;
    else process.env.PICKS_OFF = prevPicks;
    if (prevRate === undefined) delete process.env.MAX_BLOCKS_PER_HOUR;
    else process.env.MAX_BLOCKS_PER_HOUR = prevRate;
  }
}

delete process.env.PICKS_OFF;
delete process.env.MAX_BLOCKS_PER_HOUR;
check("picks are on unless asked", picksOff() === false && maxBlocksPerHour() === 60);

await withEnv({ picks: "1" }, async () => {
  check("PICKS_OFF=1 turns picks off", picksOff() === true && maxBlocksPerHour() === 60);
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const seen = watch(client);
  const ran = await runCase({ books, client, steps: 3 });
  check("PICKS_OFF builds no pick block", seen.pickBuilds === 0 && seen.pickQuotes === 0 && ran.client.publishes.length === 0, JSON.stringify(ran.client.publishes));
  check("PICKS_OFF logs once inside ten minutes", notes(ran.logs).length === 1, notes(ran.logs).join("\n"));
  check("PICKS_OFF sleeps 30s when no payout is due", ran.sleeps.length === 3 && ran.sleeps.every((ms) => ms === 30000), ran.sleeps.join(","));
});

await withEnv({ picks: "1" }, async () => {
  const books = makeBooks(false);
  const client = makeClient(books);
  const ran = await runCase({ books, client, steps: 21 });
  check("the picks-off line repeats after ten minutes", notes(ran.logs).length === 2, String(notes(ran.logs).length));
});

await withEnv({ picks: "1" }, async () => {
  const books = makeBooks(true);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") });
  const seen = watch(client);
  const ran = await runCase({
    books,
    client,
    send: true,
    steps: 1,
    state: payoutState(),
    clock: start,
  });
  const payouts = ran.client.publishes.filter((row) => row.kind === "payout");
  const picks = ran.client.publishes.filter((row) => row.kind === "pick");
  check("PICKS_OFF still pays out", payouts.length === 1, ran.client.publishes.map((row) => row.kind).join(","));
  check("PICKS_OFF does not publish a pick", picks.length === 0 && seen.pickBuilds === 0 && seen.pickQuotes === 0, String(seen.pickBuilds));
});

await withEnv({ rate: "0" }, async () => {
  check("a zero block rate turns picks off and keeps the hourly default", picksOff() === true && maxBlocksPerHour() === 60);
  const books = makeBooks(true);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), payoutQuote: fromKta("0.00404") });
  const seen = watch(client);
  const ran = await runCase({
    books,
    client,
    send: true,
    steps: 1,
    state: payoutState(),
    clock: start,
  });
  const idleBooks = makeBooks(false);
  const idleClient = makeClient(idleBooks);
  const idle = await runCase({ books: idleBooks, client: idleClient, steps: 2 });
  check("a zero block rate still pays and builds no pick", ran.client.publishes.some((row) => row.kind === "payout") && seen.pickBuilds === 0 && ran.client.publishes.every((row) => row.kind !== "pick"), ran.client.publishes.map((row) => row.kind).join(","));
  check("a zero block rate sleeps 30s when idle and logs once", idle.sleeps.every((ms) => ms === 30000) && notes(idle.logs).length === 1, idle.sleeps.join(","));
});

await withEnv({}, async () => {
  const books = makeBooks(false);
  const client = makeClient(books, { pickQuote: fromKta("0.006"), voteFee: fromKta("0.006") });
  const seen = watch(client);
  const ran = await runCase({ books, client, steps: 1 });
  check("picks stay on by default", seen.pickBuilds === 1 && ran.client.publishes.some((row) => row.kind === "pick"), String(seen.pickBuilds));
  check("the default run does not say picks are off", notes(ran.logs).length === 0);
});

console.log("fee-picks-off checks", passed);
