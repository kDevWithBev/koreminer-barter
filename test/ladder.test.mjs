import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  transferToken,
} from "../src/ladder.mjs";
import { houseLine } from "../src/page.mjs";

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
  assert.equal(body.wallets[0].buyerNights, 1);
  assert.equal(body.buyers[0].buyerRank, 1);
  assert.equal(body.rungs["Practice Shield"], 1);
  assert.equal(body.mode, "dry_run");
  const text = JSON.stringify(body);
  assert.equal(/keeta_[a-z0-9]{20,}/.test(text), false);
  assert.equal(/floor|yield|\bapr\b|dividend|passive income|guaranteed|more rewards coming/i.test(text), false);
});
