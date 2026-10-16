import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { clearingPrice } from "../src/clear.mjs";
import { nightCounts, eligibility } from "../src/eligibility.mjs";
import { runCall } from "../src/engine.mjs";
import { HOUSE, assertHouse, quote } from "../src/house.mjs";
import { BARTER_LIVE } from "../src/live.mjs";
import { confirmOpen, intentOpen, nextCallAt, callClockLabel } from "../src/time.mjs";
import { truncateWallet } from "../src/publish.mjs";
import { houseLine } from "../src/page.mjs";

const OPEN = "2026-10-17T00:30:00.000Z";
const ROOT = new URL("..", import.meta.url).pathname;

function night(extra = {}) {
  return {
    night: "2026-10-16",
    costToMine: [1, 1, 1, 1, 1, 1, 1],
    house: { kta: 50, kore: 50, mid: 1 },
    balances: {},
    intents: [],
    history: {},
    barterers: [],
    ...extra,
  };
}

function sell(wallet, qty, limit) {
  return { wallet, side: "sell_all", amount: qty, limit, submitted_at: OPEN };
}

function buy(wallet, qty, limit) {
  return { wallet, side: "buy", amount: qty, limit, submitted_at: OPEN };
}

test("live switch stays off", () => {
  assert.equal(BARTER_LIVE, false);
});

test("house quote assertion", () => {
  assert.doesNotThrow(() => assertHouse(HOUSE));
  assert.throws(() =>
    assertHouse({ ...HOUSE, skew: 0.9, spread: 0.005, fee: 0.005 }),
  );
  const even = quote(HOUSE, { kta: 50, kore: 50 }, 1);
  assert.ok(Math.abs(even.bid - 0.985) < 1e-9);
  assert.ok(Math.abs(even.ask - 1.015) < 1e-9);
  const heavy = quote(HOUSE, { kta: 20, kore: 80 }, 1);
  assert.equal(heavy.mayBuy, false);
});

test("intent window and confirm window, including the other side of the clock change", () => {
  assert.equal(intentOpen("2026-10-17T00:14:59.000Z"), false);
  assert.equal(intentOpen("2026-10-17T00:15:00.000Z"), true);
  assert.equal(intentOpen("2026-10-17T00:55:00.000Z"), true);
  assert.equal(intentOpen("2026-10-17T00:55:01.000Z"), false);
  assert.equal(intentOpen("2026-01-17T01:14:59.000Z"), false);
  assert.equal(intentOpen("2026-01-17T01:15:00.000Z"), true);
  assert.equal(intentOpen("2026-01-17T01:55:00.000Z"), true);
  assert.equal(intentOpen("2026-01-17T01:55:01.000Z"), false);
  assert.equal(confirmOpen("2026-10-17T01:10:00.000Z"), true);
  assert.equal(confirmOpen("2026-10-17T01:10:01.000Z"), false);
  assert.equal(confirmOpen("2026-01-17T02:10:00.000Z"), true);
  assert.equal(confirmOpen("2026-01-17T02:10:01.000Z"), false);
});

test("balanced book clears one price", () => {
  const result = runCall(
    night({
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [sell("seller", 10), buy("buyer", 10, 1.2)],
    }),
  );
  assert.equal(result.publicCall.status, "clear");
  assert.equal(result.publicCall.clearingPrice, 1);
  assert.equal(result.publicCall.koreMatched, 10);
  assert.equal(result.publicCall.feesToHouse, 0.1);
  assert.equal(result.publicCall.mode, "dry_run");
  assert.equal(result.publicCall.fills.length, 2);
});

test("sell-heavy book does not make the house pay above its bid", () => {
  const result = runCall(
    night({
      balances: { seller: { kore: 20, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [sell("seller", 20), buy("buyer", 10, 1.2)],
    }),
  );
  assert.equal(result.publicCall.koreMatched, 10);
  assert.equal(result.publicCall.houseBuyKore, 0);
});

test("buy-heavy book does not make the house sell under its ask", () => {
  const result = runCall(
    night({
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [sell("seller", 10), buy("buyer", 20, 1.2)],
    }),
  );
  assert.equal(result.publicCall.koreMatched, 10);
  assert.equal(result.publicCall.houseSellKore, 0);
});

test("empty book and a book that does not cross", () => {
  assert.equal(runCall(night()).publicCall.status, "no_clear");
  const missed = runCall(
    night({
      costToMine: [2, 2, 2, 2, 2, 2, 2],
      house: { kta: 50, kore: 50, mid: 2 },
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [sell("seller", 10, 2), buy("buyer", 10, 1)],
    }),
  );
  assert.equal(missed.publicCall.status, "no_clear");
  assert.equal(missed.publicCall.fillCount, 0);
});

test("recent buyer wins a tie, and a skipper does not set the price", () => {
  const tie = runCall(
    night({
      balances: {
        seller: { kore: 10, kta: 0 },
        "buyer-old-wallet-0011": { kore: 0, kta: 100 },
        "buyer-new-wallet-0099": { kore: 0, kta: 100 },
      },
      history: {
        "buyer-old-wallet-0011": { lastBuyAt: "2026-10-01T00:00:00.000Z", skips: 0 },
        "buyer-new-wallet-0099": { lastBuyAt: "2026-10-10T00:00:00.000Z", skips: 0 },
      },
      intents: [sell("seller", 10), buy("buyer-old-wallet-0011", 10, 1.2), buy("buyer-new-wallet-0099", 10, 1.2)],
    }),
  );
  const newerFill = tie.publicCall.fills.find((fill) => fill.wallet.includes("0099"));
  const olderFill = tie.publicCall.fills.find((fill) => fill.wallet.includes("0011"));
  assert.equal(newerFill.amount, 10);
  assert.equal(olderFill, undefined);

  const skipped = runCall(
    night({
      balances: {
        seller: { kore: 10, kta: 0 },
        "normal-wallet-1111": { kore: 0, kta: 100 },
        "skipper-wallet-2222": { kore: 0, kta: 100 },
      },
      history: {
        "normal-wallet-1111": { lastBuyAt: "2026-10-01T00:00:00.000Z", skips: 0 },
        "skipper-wallet-2222": { lastBuyAt: "2026-10-15T00:00:00.000Z", skips: 2 },
      },
      intents: [sell("seller", 10), buy("normal-wallet-1111", 10, 1.2), buy("skipper-wallet-2222", 10, 2)],
    }),
  );
  assert.equal(skipped.publicCall.clearingPrice, 1);
  assert.equal(skipped.publicCall.fills.find((fill) => fill.wallet.includes("1111")).amount, 10);
  assert.equal(skipped.publicCall.fills.find((fill) => fill.wallet.includes("2222")), undefined);
});

test("fee is once per fill, and a barterer pays the lower rate", () => {
  const result = runCall(
    night({
      barterers: ["buyer"],
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [sell("seller", 10), buy("buyer", 10, 1.2)],
    }),
  );
  const sellerFee = result.publicCall.fills.find((fill) => fill.side === "sell").fee;
  const buyerFee = result.publicCall.fills.find((fill) => fill.side === "buy").fee;
  assert.equal(sellerFee, 0.05);
  assert.equal(buyerFee, 0.025);
  const sum = result.publicCall.fills.reduce((total, fill) => total + fill.fee, 0);
  assert.equal(Math.round(sum * 1e8) / 1e8, result.publicCall.feesToHouse);
});

test("house buys leftover only inside the cap, the pot, and the stop", () => {
  const bought = runCall(
    night({
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [sell("seller", 10, 0.98), buy("buyer", 4, 0.98)],
    }),
  );
  assert.equal(bought.publicCall.clearingPrice, 0.98);
  assert.ok(bought.publicCall.houseBuyKore * 0.98 <= 5 + 1e-8);
  assert.equal(bought.publicCall.houseBuyKore, 5);

  const stopped = runCall(
    night({
      house: { kta: 20, kore: 80, mid: 1 },
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [sell("seller", 10, 0.98), buy("buyer", 4, 0.98)],
    }),
  );
  assert.equal(stopped.publicCall.houseBuyKore, 0);

  const thin = runCall(
    night({
      house: { kta: 3, kore: 10, mid: 1 },
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 1 } },
      intents: [sell("seller", 10, 0.98), buy("buyer", 1, 0.98)],
    }),
  );
  assert.ok(thin.publicCall.houseBuyKore * 0.98 <= 3 + 1e-8);
});

test("a skipped confirm is dropped and the house may take that gap at its own quote", () => {
  const result = runCall(
    night({
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [sell("seller", 10, 0.98), buy("buyer", 10, 0.98)],
      confirms: { seller: "confirmed", buyer: "skipped" },
    }),
  );
  assert.equal(result.server.skips.includes("buyer"), true);
  assert.equal(result.publicCall.fills.some((fill) => fill.wallet.startsWith("buye")), false);
  assert.ok(result.publicCall.houseBuyKore > 0);
  assert.ok(result.publicCall.houseBuyKore * 0.98 <= 5 + 1e-8);
});

test("balance cap and seller default limit", () => {
  const result = runCall(
    night({
      costToMine: [0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05],
      house: { kta: 50, kore: 50, mid: 0.05 },
      balances: {
        rich: { kore: 4, kta: 0 },
        lower: { kore: 4, kta: 0 },
        buyer: { kore: 0, kta: 1 },
      },
      intents: [
        { wallet: "rich", side: "sell_all", amount: 999, submitted_at: OPEN },
        { wallet: "lower", side: "sell_all", amount: 4, limit: 0.09, submitted_at: OPEN },
        buy("buyer", 100, 0.05),
      ],
    }),
  );
  assert.equal(result.server.orders.sells.find((order) => order.wallet === "rich").qty, 4);
  assert.equal(result.server.orders.sells.find((order) => order.wallet === "lower").limit, 0.05);
  const lowered = runCall(
    night({
      costToMine: [0.05, 0.05, 0.05],
      balances: { seller: { kore: 2, kta: 0 }, buyer: { kore: 0, kta: 10 } },
      intents: [sell("seller", 2, 0.02), buy("buyer", 2, 0.02)],
    }),
  );
  assert.equal(lowered.server.orders.sells[0].limit, 0.02);
  assert.equal(lowered.publicCall.clearingPrice, 0.02);
});

test("outside the window is rejected", () => {
  const result = runCall(
    night({
      balances: { seller: { kore: 5, kta: 0 } },
      intents: [{ wallet: "seller", side: "sell_all", amount: 5, submitted_at: "2026-10-17T00:14:59.000Z" }],
    }),
  );
  assert.equal(result.server.rejected.length, 1);
  assert.equal(result.publicCall.status, "no_clear");
});

test("a day needs a 0.02 KTA average, and weight uses the median cap", () => {
  assert.equal(nightCounts([0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02]), true);
  assert.equal(nightCounts([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]), false);
  assert.equal(nightCounts([0.03, 0.01]), true);
  const weights = eligibility({
    fuelNights: {
      one: [0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02],
      two: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
    },
    mined: {
      one: { streak: 4, shieldDays: 2, kore: 1000 },
      two: { streak: 4, shieldDays: 0, kore: 100 },
    },
  });
  assert.equal(weights.counted.one, true);
  assert.equal(weights.counted.two, false);
  assert.equal(weights.koreCap, 550);
  assert.equal(weights.weights.one, 5 * 550);
});

test("public file hides the wallet and stays a dry run", () => {
  const result = runCall(
    night({
      balances: {
        keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy: { kore: 1, kta: 0 },
        keeta_aabd7qpxd6li6qwkyr4qjlzao7fu6wadr6pwhekxmem2iqtsb27wn5yphdqyv5y: { kore: 0, kta: 10 },
      },
      intents: [
        sell("keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy", 1),
        buy("keeta_aabd7qpxd6li6qwkyr4qjlzao7fu6wadr6pwhekxmem2iqtsb27wn5yphdqyv5y", 1, 1.2),
      ],
    }),
  );
  const text = JSON.stringify(result.publicCall);
  assert.equal(result.publicCall.mode, "dry_run");
  assert.equal(text.includes("keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy"), false);
  assert.match(text, /keeta_aabz…bbvy/);
  assert.equal(/floor|yield|apr|dividend|passive income|guaranteed|more rewards coming/i.test(text), false);
  assert.equal(result.server.flags && result.publicCall.flags, undefined);
});

test("cluster flag stays off the public file and off the fill", () => {
  const result = runCall(
    night({
      cluster: { seller: true },
      balances: { seller: { kore: 4, kta: 0 }, buyer: { kore: 0, kta: 10 } },
      intents: [sell("seller", 4), buy("buyer", 4, 1.2)],
    }),
  );
  assert.equal(result.server.flags.seller, true);
  assert.equal(result.publicCall.koreMatched, 4);
  assert.equal(JSON.stringify(result.publicCall).includes("cluster"), false);
});

test("no source file reads an environment or a signing module", () => {
  const needle = ["process", "env"].join(".");
  const roots = [join(ROOT, "src"), join(ROOT, "bin")];
  const files = [];
  for (const root of roots) {
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (statSync(path).isFile()) files.push(path);
    }
  }
  const text = files.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.equal(text.includes(needle), false);
  assert.equal(/keetanet|seed\.txt|signTransaction|privateKey/i.test(text), false);
});

test("an empty house uses the cost series and never sells KORE it does not hold", () => {
  const cost = [0.0027, 0.0027, 0.0027, 0.0027, 0.0027, 0.0027, 0.0027];
  const result = runCall(
    night({
      costToMine: cost,
      house: { kta: 100, kore: 0, mid: 1 },
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 10 } },
      intents: [sell("seller", 10), buy("buyer", 20, 0.01)],
    }),
  );
  assert.ok(result.publicCall.clearingPrice < 1);
  assert.ok(Math.abs(result.publicCall.clearingPrice - 0.0027) < 1e-8);
  assert.equal(result.server.quote.ask, null);
  assert.ok(result.server.quote.bid > 0);
  assert.equal(result.publicCall.houseSellKore, 0);

  const ranked = runCall(
    night({
      lastClear: 0.004,
      costToMine: cost,
      house: { kta: 100, kore: 0 },
      balances: { seller: { kore: 2, kta: 0 }, buyer: { kore: 0, kta: 5 } },
      intents: [sell("seller", 2), buy("buyer", 2, 0.01)],
    }),
  );
  assert.ok(Math.abs(ranked.publicCall.clearingPrice - 0.004) < 1e-8);
  assert.equal(ranked.publicCall.houseSellKore, 0);
});

test("no reference and no crossing orders does not clear", () => {
  const missed = runCall(
    night({
      costToMine: [],
      house: { kta: 100, kore: 0, mid: 1 },
      balances: { seller: { kore: 10, kta: 0 }, buyer: { kore: 0, kta: 10 } },
      intents: [sell("seller", 10, 2), buy("buyer", 10, 1)],
    }),
  );
  assert.equal(missed.publicCall.status, "no_clear");
  assert.equal(missed.publicCall.clearingPrice, null);
  assert.equal(missed.server.quote.quoted, false);
  assert.equal(missed.publicCall.houseBuyKore, 0);
  assert.equal(missed.publicCall.houseSellKore, 0);

  const miners = runCall(
    night({
      costToMine: [],
      house: { kta: 100, kore: 0, mid: 1 },
      balances: { seller: { kore: 4, kta: 0 }, buyer: { kore: 0, kta: 10 } },
      intents: [sell("seller", 4, 0.002), buy("buyer", 8, 0.003)],
    }),
  );
  assert.equal(miners.publicCall.status, "clear");
  assert.ok(miners.publicCall.clearingPrice < 1);
  assert.equal(miners.publicCall.houseBuyKore, 0);
  assert.equal(miners.publicCall.houseSellKore, 0);
});

test("KORE moves in whole coins and the fee stays in KTA", () => {
  const odd = runCall(
    night({
      balances: { seller: { kore: 5.8, kta: 0 }, buyer: { kore: 0, kta: 100 } },
      intents: [{ wallet: "seller", side: "sell_half", submitted_at: OPEN }, buy("buyer", 10, 1.2)],
    }),
  );
  assert.equal(odd.server.orders.sells[0].qty, 2);
  assert.equal(odd.publicCall.fills.find((fill) => fill.side === "sell").amount, 2);

  const one = runCall(
    night({
      balances: { holder: { kore: 1, kta: 0 } },
      intents: [{ wallet: "holder", side: "sell_half", submitted_at: OPEN }],
    }),
  );
  assert.equal(one.server.orders.sells.length, 0);
  assert.deepEqual(one.server.adjustments, [{ wallet: "holder", instead: "sell_all" }]);

  const partial = runCall(
    night({
      balances: { seller: { kore: 5, kta: 0 }, buyer: { kore: 0, kta: 2.9 * 1.005 } },
      intents: [sell("seller", 5), buy("buyer", 10.9, 1)],
    }),
  );
  const bought = partial.publicCall.fills.find((fill) => fill.side === "buy");
  assert.equal(bought.amount, 2);
  assert.equal(bought.fee, 0.01);
  assert.equal(Number.isInteger(bought.amount), true);
  assert.ok(partial.publicCall.fills.every((fill) => Number.isInteger(fill.amount)));
});

test("a wallet shows ten characters, then four", () => {
  const full = "keeta_aabd7qpxd6li6qwkyr4qjlzao7fu6wadr6pwhekxmem2iqtsb27wn5yphdqyv5y";
  const shown = truncateWallet(full);
  const [lead, tail] = shown.split("…");
  assert.equal(shown, "keeta_aabd…yv5y");
  assert.equal(lead.length, 10);
  assert.equal(tail.length, 4);
  assert.equal(shown.includes(full.slice(10, -4)), false);
});

test("the house line says it is buying only when it holds no KORE", () => {
  const buying = houseLine({ houseKta: 100.000054, houseKore: 0 });
  assert.equal(buying, "House holds 100.000054 KTA and 0 KORE. House is buying only tonight.");
  const both = houseLine({ houseKta: 10, houseKore: 4 });
  assert.equal(both, "House holds 10 KTA and 4 KORE.");
  assert.equal(both.includes("buying only"), false);
  const page = readFileSync(join(ROOT, "public/barter/index.html"), "utf8");
  assert.equal(page.includes("House is buying only tonight."), true);
  assert.equal(page.includes("Practice call. No coins move."), true);
  assert.equal(/<form/i.test(page), false);
  assert.equal(/\bBase\b/.test(page), false);
  assert.equal(/floor|yield|\bapr\b|dividend|passive income|guaranteed|more rewards coming/i.test(page), false);
});

test("the call targets midnight UTC across the November change", () => {
  const tonight = nextCallAt("2026-10-16T21:49:00.000Z");
  assert.equal(tonight.toISOString(), "2026-10-17T00:00:00.000Z");
  assert.equal(callClockLabel(tonight), "8:00 PM ET");

  const stillDaylight = nextCallAt("2026-10-31T22:00:00.000Z");
  assert.equal(stillDaylight.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(callClockLabel(stillDaylight), "8:00 PM ET");

  const afterChange = nextCallAt("2026-11-01T12:00:00.000Z");
  assert.equal(afterChange.toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(callClockLabel(afterChange), "7:00 PM ET");

  const page = readFileSync(join(ROOT, "public/barter/index.html"), "utf8");
  assert.equal(page.includes("hour > 20"), false);
  assert.equal(page.includes("Date.UTC"), true);
});

test("clearing price helper ignores a skipper", () => {
  const price = clearingPrice({
    sells: [{ wallet: "s", qty: 10, limit: 1, half: false }],
    buys: [
      { wallet: "b", qty: 10, limit: 1.2, kta: 100, half: false },
      { wallet: "k", qty: 10, limit: 5, kta: 100, half: true },
    ],
    quoted: { center: 1.1, reference: 1, ask: 1.015, bid: 0.985 },
    cfg: HOUSE,
    barterers: new Set(),
  });
  assert.equal(price, 1);
});
