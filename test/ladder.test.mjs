import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { HOUSE } from "../src/house.mjs";
import {
  applyShields,
  bartererStatus,
  buildPublicLadder,
  buyerBoard,
  buyerNightCounts,
  countedDay,
  daysFromFuel,
  noteBuyer,
  rankFor,
  streaksFromHistory,
  transferToken,
} from "../src/ladder.mjs";
import { ensureHistory, loadWalletHistory } from "../src/history.mjs";
import { houseLine, streakLines } from "../src/page.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const repeat = (count, value) => Array.from({ length: count }, () => value);

test("rank and next rank follow the fixed rungs", () => {
  const expect = {
    0: [null, "Practice Shield"],
    13: [null, "Practice Shield"],
    14: ["Practice Shield", "Shift Boss Shield"],
    27: ["Practice Shield", "Shift Boss Shield"],
    28: ["Shift Boss Shield", "Narrator Book"],
    55: ["Shift Boss Shield", "Narrator Book"],
    56: ["Narrator Book", "Barterer"],
    83: ["Narrator Book", "Barterer"],
    84: ["Barterer", null],
    120: ["Barterer", null],
  };
  for (const [days, [rank, nextRank]] of Object.entries(expect)) {
    const got = rankFor(Number(days));
    assert.equal(got.rank, rank, days);
    assert.equal(got.nextRank, nextRank, days);
  }
});

test("Practice Shield is once, Shift Boss Shield saves one miss, and a saved day counts half", () => {
  const saved = applyShields([...repeat(14, true), false]);
  assert.equal(saved.streak, 14);
  assert.equal(saved.shields.practice.held, true);
  assert.equal(saved.shields.practice.used, true);
  assert.equal(saved.weight, 14.5);

  const second = applyShields([...repeat(14, true), false, ...repeat(5, true), false]);
  assert.equal(second.shields.practice.used, true);
  assert.equal(second.shields.shiftBoss.held, false);
  assert.equal(second.streak, 0);

  const shift = applyShields([...repeat(14, true), false, ...repeat(14, true), false]);
  assert.equal(shift.shields.shiftBoss.held, true);
  assert.equal(shift.shields.shiftBoss.used, true);
  assert.equal(shift.streak, 28);
  assert.equal(shift.weight, 29);
});

test("a thin fuel series does not count, and the engine rule is the one that decides", () => {
  assert.equal(countedDay([0.02]), true);
  assert.equal(countedDay([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]), false);
  assert.equal(applyShields(daysFromFuel(repeat(20, 0.01))).streak, 0);
  assert.equal(applyShields(daysFromFuel(repeat(14, 0.02))).rank, "Practice Shield");
});

test("the token cannot move, and a revoked token loses the perks and the lower fee", () => {
  const record = { wallet: "keeta_holder", transferable: false };
  const moved = transferToken(record, "keeta_other");
  assert.equal(moved.ok, false);
  assert.equal(moved.record.wallet, "keeta_holder");
  assert.equal(record.wallet, "keeta_holder");

  const live = bartererStatus({ streak: 84, region: "US", revoked: false });
  assert.equal(live.offered, true);
  assert.equal(live.fee, HOUSE.bartererFee);
  assert.equal(live.perks.includes("badge"), true);
  assert.equal(live.message, "Barterers trade cheaper at the call.");

  const revoked = bartererStatus({ streak: 120, region: "US", revoked: true });
  assert.equal(revoked.offered, false);
  assert.deepEqual(revoked.perks, []);
  assert.equal(revoked.fee, HOUSE.fee);
  assert.equal(HOUSE.fee, 0.005);
  assert.equal(HOUSE.bartererFee, 0.0025);

  const file = JSON.parse(readFileSync(join(ROOT, "data/revoked.json"), "utf8"));
  assert.deepEqual(file.wallets, []);
});

test("an EU wallet cannot claim and pays the full fee, and a wallet outside the region can", () => {
  const eu = bartererStatus({ streak: 84, region: "DE", revoked: false });
  assert.equal(eu.offered, false);
  assert.equal(eu.fee, HOUSE.fee);
  assert.equal(eu.message, "Not available in your region");

  const outside = bartererStatus({ streak: 84, region: "US", revoked: false });
  assert.equal(outside.offered, true);
  assert.equal(outside.fee, HOUSE.bartererFee);
  assert.equal(outside.message, "Barterers trade cheaper at the call.");
});

test("buyer nights ignore a short or unconfirmed buy and never change the mining streak", () => {
  assert.equal(buyerNightCounts({ side: "buy", kta: 0.99, confirmed: true }), false);
  assert.equal(buyerNightCounts({ side: "buy", kta: 1, confirmed: true }), true);
  assert.equal(buyerNightCounts({ side: "buy", kta: 5, confirmed: false }), false);
  const mining = { streak: 9, weight: 9 };
  const after = noteBuyer(mining, [
    { side: "buy", kta: 0.99, confirmed: true },
    { side: "buy", kta: 1, confirmed: true },
    { side: "buy", kta: 4, confirmed: false },
  ]);
  assert.deepEqual(mining, { streak: 9, weight: 9 });
  assert.equal(after.streak, 9);
  assert.equal(after.weight, 9);
  assert.equal(after.buyerNights, 1);
});

test("the buyer board keeps fueled miners only, and fifty buyer-only wallets take no places", () => {
  const miners = {};
  const buyers = {};
  for (let i = 0; i < 50; i += 1) buyers[`keeta_only${String(i).padStart(2, "0")}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`] = 20;
  const miner = "keeta_aabd7qpxd6li6qwkyr4qjlzao7fu6wadr6pwhekxmem2iqtsb27wn5yphdqyv5y";
  miners[miner] = { fuel: "1.00000", streak: 3 };
  miners.keeta_empty = { fuel: "0.00000", streak: 4 };
  buyers[miner] = 2;
  buyers.keeta_empty = 99;
  const board = buyerBoard({ buyers, miners });
  assert.equal(board.length, 1);
  assert.equal(board[0].wallet, miner);
  assert.equal(board[0].buyerRank, 1);
  assert.equal(board.some((row) => row.wallet.startsWith("keeta_only")), false);
  assert.equal(board.some((row) => row.wallet === "keeta_empty"), false);
});

test("practice mode hides the house balance", () => {
  const buying = houseLine({ mode: "dry_run", houseKta: 100.000054, houseKore: 0 });
  assert.equal(buying, "House is buying only tonight.");
  assert.equal(buying.includes("100.000054"), false);
  assert.equal(houseLine({ mode: "dry_run", houseKta: 100, houseKore: 4 }), "");
  const page = readFileSync(join(ROOT, "public/barter/index.html"), "utf8");
  assert.equal(page.includes("House is buying only tonight."), true);
  assert.equal(page.includes("Barterers trade cheaper at the call."), true);
  assert.equal(page.includes("Perks may change."), true);
  assert.equal(page.includes("Mining streak "), true);
  assert.equal(page.includes("Ladder streak "), true);
  assert.equal(page.includes("shields used"), true);
  assert.equal(/<form/i.test(page), false);
  assert.equal(/\b(base|ethereum|solana)\b/i.test(page), false);
  assert.equal(/floor|yield|\bapr\b|dividend|passive income|guaranteed|more rewards coming/i.test(page), false);
});

test("the public ladder truncates wallets and keeps the copy clean", () => {
  const miner = "keeta_aabd7qpxd6li6qwkyr4qjlzao7fu6wadr6pwhekxmem2iqtsb27wn5yphdqyv5y";
  const body = buildPublicLadder({
    miners: { [miner]: { fuel: "1.00000", streak: 14 } },
    buys: [{ wallet: miner, side: "buy", kta: 1, confirmed: true }],
    revoked: [],
    regions: {},
  });
  assert.equal(body.wallets[0].wallet, "keeta_aabd…yv5y");
  assert.equal(body.wallets[0].rank, "Practice Shield");
  assert.equal(body.wallets[0].miningStreak, 14);
  assert.equal(body.wallets[0].ladderStreak, 14);
  assert.equal(body.wallets[0].shieldsUsed, 0);
  assert.equal(body.wallets[0].buyerNights, 1);
  assert.equal(body.buyers[0].buyerRank, 1);
  assert.equal(body.rungs["Practice Shield"], 1);
  assert.equal(body.mode, "dry_run");
  const text = JSON.stringify(body);
  assert.equal(/keeta_[a-z0-9]{20,}/.test(text), false);
  assert.equal(/floor|yield|\bapr\b|dividend|passive income|guaranteed|more rewards coming/i.test(text), false);
});

function countedNights(count) {
  return Array.from({ length: count }, (_, index) => ({ fuel: "1.00000", streak: index + 1 }));
}

test("30 nights, one miss with a shield, then 5 more leaves the runner at 5 and the ladder at 35", () => {
  const nights = [...countedNights(30), { fuel: "1.00000", streak: 0 }, ...countedNights(5)];
  const got = streaksFromHistory({ nights });
  assert.equal(got.miningStreak, 5);
  assert.equal(got.ladderStreak, 35);
  assert.equal(got.shieldsUsed, 1);
  assert.equal(got.weight, 35.5);
  assert.equal(got.rank, "Shift Boss Shield");

  const seeded = streaksFromHistory({
    seedStreak: 30,
    nights: [{ fuel: "1.00000", streak: 0 }, ...countedNights(5)],
  });
  assert.equal(seeded.miningStreak, 5);
  assert.equal(seeded.ladderStreak, 35);
  assert.equal(seeded.weight, 35.5);

  const lines = streakLines({ miningStreak: 5, ladderStreak: 35, shieldsUsed: 1 });
  assert.equal(lines.mining, "Mining streak 5");
  assert.equal(lines.ladder, "Ladder streak 35 (1 shield used)");
});

test("a miss without a shield resets the ladder", () => {
  const got = streaksFromHistory({
    nights: [...countedNights(10), { fuel: "1.00000", streak: 0 }],
  });
  assert.equal(got.miningStreak, 0);
  assert.equal(got.ladderStreak, 0);
  assert.equal(got.shieldsUsed, 0);
  assert.equal(got.shields.practice.held, false);
});

test("two misses with one shield reset the ladder", () => {
  const got = streaksFromHistory({
    nights: [...countedNights(14), { fuel: "1.00000", streak: 0 }, { fuel: "1.00000", streak: 0 }],
  });
  assert.equal(got.shields.practice.used, true);
  assert.equal(got.shields.shiftBoss.held, false);
  assert.equal(got.ladderStreak, 0);
  assert.equal(got.miningStreak, 0);
});

test("history records the lookup and never writes the runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "kore-history-"));
  const lookupPath = join(dir, "lookup.json");
  const lookup = { miners: { keeta_one: { fuel: "3.00000", streak: 4 } } };
  const body = JSON.stringify(lookup);
  copyFileSync(join(ROOT, "fixtures/lookup-2026-10-16.json"), join(dir, "untouched-lookup.json"));
  const untouched = readFileSync(join(dir, "untouched-lookup.json"));
  writeFileSync(lookupPath, body);
  const history = join(dir, "history");
  const first = ensureHistory({ dir: history, night: "2026-10-16", lookup });
  assert.equal(first.seeded, true);
  assert.equal(first.appended, false);
  const second = ensureHistory({ dir: history, night: "2026-10-16", lookup });
  assert.equal(second.appended, false);
  assert.equal(existsSync(join(history, "2026-10-16.json")), false);
  const third = ensureHistory({
    dir: history,
    night: "2026-10-17",
    lookup: { miners: { keeta_one: { fuel: "2.50000", streak: 5 } } },
  });
  assert.equal(third.appended, true);
  const loaded = loadWalletHistory(history);
  assert.equal(loaded.keeta_one.seedStreak, 4);
  assert.equal(loaded.keeta_one.nights.length, 1);
  assert.equal(streaksFromHistory(loaded.keeta_one).ladderStreak, 5);
  assert.equal(readFileSync(lookupPath, "utf8"), body);
  assert.equal(readFileSync(join(dir, "untouched-lookup.json")).equals(untouched), true);
  assert.equal(existsSync(join(ROOT, "books.json")), false);
  assert.throws(() => ensureHistory({ dir: "/opt/koreminer/data/history", night: "2026-10-18", lookup }));
  assert.throws(() => ensureHistory({ dir: "/opt/koreminer/books.json", night: "2026-10-18", lookup }));
  assert.throws(() => ensureHistory({ dir: join(dir, "lookup.json"), night: "2026-10-18", lookup }));
});

test("the dry run appends history from the lookup and leaves that file alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "kore-sim-"));
  const lookupCopy = join(dir, "lookup.json");
  copyFileSync(join(ROOT, "fixtures/lookup-2026-10-16.json"), lookupCopy);
  const before = readFileSync(lookupCopy);
  const publicDir = join(dir, "public");
  const historyDir = join(dir, "history");
  const args = [
    join(ROOT, "bin/sim.mjs"),
    "--lookup", lookupCopy,
    "--intents", join(ROOT, "fixtures/intents-2026-10-16.json"),
    "--history", historyDir,
    "--public", publicDir,
  ];
  const run = spawnSync(process.execPath, [...args, "--night", "2026-10-16"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(join(historyDir, "seed.json")), true);
  assert.equal(existsSync(join(historyDir, "2026-10-16.json")), false);
  const again = spawnSync(process.execPath, [...args, "--night", "2026-10-17"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(existsSync(join(historyDir, "2026-10-17.json")), true);
  assert.equal(readFileSync(lookupCopy).equals(before), true);
  const ladder = JSON.parse(readFileSync(join(publicDir, "ladder.json"), "utf8"));
  assert.equal(ladder.mode, "dry_run");
  assert.equal(ladder.wallets.length > 0, true);
  assert.equal(ladder.wallets.every((row) => typeof row.miningStreak === "number"), true);
  assert.equal(ladder.wallets.every((row) => typeof row.ladderStreak === "number"), true);
  assert.equal(/keeta_[a-z0-9]{20,}/.test(JSON.stringify(ladder)), false);
  const lines = streakLines(ladder.wallets[0]);
  assert.equal(lines.mining.startsWith("Mining streak "), true);
  assert.equal(lines.ladder.startsWith("Ladder streak "), true);
});

