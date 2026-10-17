import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FOOTER,
  MALFORMED,
  NO_LADDER,
  UNKNOWN,
  WARMING,
  closeLabel,
  displayWallet,
  isKeetaAddress,
  leaderboard,
  median,
  nextClose,
  publicText,
  readPlayer,
  shortWallet,
  summary,
  updatedLabel,
} from "../src/card.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const BANNED = /floor|yield|\bapr\b|dividend|passive income|guaranteed|more rewards coming|\bethereum\b|\bsolana\b|\bbase\b/i;

function addr(tag) {
  return `keeta_${(tag + "0".repeat(60)).slice(0, 60)}`;
}

const known = addr("aabdknown");
const other = addr("bbbbother");
const missing = addr("ccccmisss");

function board() {
  return {
    updated: "2026-10-16T21:18:29.945Z",
    miners: {
      [known]: { fuel: "12027.00000", streak: 16, paid: "49607", waiting: "16708", upgrades: ["Lamp"] },
      [other]: { fuel: "10.00000", streak: 16, paid: "100", waiting: "0" },
      [missing]: { fuel: "3.00000", streak: 4, paid: "20", waiting: "2" },
    },
  };
}

function ranks() {
  return {
    rungs: { "Practice Shield": 1, "Shift Boss Shield": 0, "Narrator Book": 0, Barterer: 0 },
    wallets: [
      {
        wallet: shortWallet(known),
        miningStreak: 16,
        ladderStreak: 16,
        rank: "Practice Shield",
        nextRank: "Shift Boss Shield",
        nextAt: 28,
        shields: { practice: { held: true, used: false }, shiftBoss: { held: false, used: false } },
        shieldsUsed: 0,
        buyerNights: 2,
        message: "",
      },
    ],
  };
}

test("a known wallet shows the shift and never the full address", () => {
  const view = readPlayer({ wallet: known.toUpperCase(), lookup: board(), ladder: ranks() });
  assert.equal(view.kind, "known");
  assert.equal(view.show, shortWallet(known));
  assert.equal(view.lines.fuel, "Fuel 12,027 KTA");
  assert.equal(view.lines.mining, "Mining streak 16");
  assert.equal(view.lines.ladder, "Ladder streak 16 (0 shields used)");
  assert.equal(view.lines.rank, "Rank Practice Shield");
  assert.equal(view.lines.next, "12 days to Shift Boss Shield");
  assert.equal(view.daysToNext, 12);
  assert.equal(view.progress, 16 / 28);
  assert.equal(view.lines.shields, "Practice Shield: held. Shift Boss Shield: not yet.");
  assert.equal(view.lines.buyers, "Buyer nights 2");
  assert.equal(view.lines.barterer, "Not a Barterer yet.");
  assert.equal(view.lines.paid, "49,607 KORE paid");
  assert.equal(view.lines.waiting, "16,708 KORE waiting");
  assert.equal(view.lines.upgrades, "Upgrades: Lamp");
  assert.equal(view.text.includes(known), false);
  assert.equal(displayWallet(known) === known, false);
});

test("an unknown wallet and a malformed wallet stay on the fixed lines", () => {
  const lookup = board();
  const unknown = readPlayer({ wallet: addr("zzzunknown"), lookup, ladder: ranks() });
  assert.equal(unknown.kind, "unknown");
  assert.equal(unknown.text, UNKNOWN);
  assert.equal(unknown.text.includes(addr("zzzunknown")), false);
  for (const bad of ["", "keeta_short", `0x${"ab".repeat(20)}`, "not a wallet"]) {
    const view = readPlayer({ wallet: bad, lookup, ladder: ranks() });
    assert.equal(view.kind, "malformed");
    assert.equal(view.text, MALFORMED);
    assert.equal(view.show, "");
    assert.equal(isKeetaAddress(bad), false);
  }
});

test("a wallet with no ladder record still shows the mining shift", () => {
  const view = readPlayer({ wallet: missing, lookup: board(), ladder: { wallets: [], rungs: {} } });
  assert.equal(view.kind, "no-ladder");
  assert.equal(view.lines.mining, "Mining streak 4");
  assert.equal(view.lines.ladder, NO_LADDER);
  assert.equal(view.lines.paid, "20 KORE paid");
  assert.equal(view.text.includes("Ladder streak 4"), false);
  assert.equal(view.text.includes(missing), false);
});

test("missing upgrades say they are coming, and a list shows the names", () => {
  const lookup = board();
  delete lookup.miners[missing].upgrades;
  const plain = readPlayer({ wallet: missing, lookup, ladder: ranks() });
  assert.equal(plain.lines.upgrades, "Upgrades: coming soon");
  lookup.miners[known].upgrades = [];
  const empty = readPlayer({ wallet: known, lookup, ladder: ranks() });
  assert.equal(empty.lines.upgrades, "No upgrades owned.");
});

test("the board sorts by streak, breaks ties by KORE paid, and keeps 25", () => {
  const top = addr("topz");
  const high = addr("tiez");
  const low = addr("tiea");
  const first = addr("sama");
  const second = addr("samb");
  const rows = leaderboard({
    miners: {
      [low]: { fuel: "1", streak: 10, paid: "5" },
      [second]: { fuel: "1", streak: 4, paid: "7" },
      [top]: { fuel: "1", streak: 12, paid: "1" },
      [first]: { fuel: "1", streak: 4, paid: "7" },
      [high]: { fuel: "1", streak: 10, paid: "50" },
    },
  });
  assert.deepEqual(rows.map((row) => row.wallet), [
    shortWallet(top),
    shortWallet(high),
    shortWallet(low),
    shortWallet(first),
    shortWallet(second),
  ]);
  const miners = {};
  const fulls = [];
  for (let i = 1; i <= 26; i += 1) {
    const wallet = addr(String(i).padStart(4, "q"));
    fulls.push(wallet);
    miners[wallet] = { fuel: "1.00000", streak: i, paid: String(i), waiting: "0" };
  }
  const capped = leaderboard({ miners });
  assert.equal(capped.length, 25);
  assert.equal(capped[0].streak, 26);
  assert.equal(capped.some((row) => row.streak === 1), false);
  const text = [...rows, ...capped].map((row) => row.line).join("\n");
  for (const full of [...fulls, top, high, low, first, second]) assert.equal(text.includes(full), false);
});

test("the median is the middle streak, and an even count meets in the middle", () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  const line = summary({
    miners: {
      [addr("m1aaaa")]: { streak: 1, paid: "10" },
      [addr("m2aaaa")]: { streak: 2, paid: "10" },
      [addr("m3aaaa")]: { streak: 3, paid: "10" },
      [addr("m4aaaa")]: { streak: 4, paid: "80" },
    },
  }).line;
  assert.equal(line, "4 miners · longest streak 4 · median streak 2.5 · 110 KORE paid");
});

test("a failed lookup does not invent a shift or print the address", () => {
  const view = readPlayer({ wallet: known, lookup: null, ladder: null, lookupOk: false });
  assert.equal(view.kind, "lookup");
  assert.equal(view.text, WARMING);
  const text = publicText({ lookup: null, ladder: null, wallet: known, lookupOk: false });
  assert.equal(text.includes(known), false);
  assert.equal(text.includes(WARMING), true);
  assert.equal(text.includes(FOOTER), true);
  assert.equal(text.includes("49,607"), false);
});

test("the public card text has no full address and the page stays read only", () => {
  const text = publicText({ lookup: board(), ladder: ranks(), wallet: `  ${known}  ` });
  assert.equal(text.includes(known), false);
  assert.equal(/keeta_[a-z0-9]{20,}/.test(text), false);
  assert.equal(BANNED.test(text), false);
  assert.equal(text.includes("49,607 KORE paid"), true);
  assert.equal(text.includes(FOOTER), true);

  const page = readFileSync(`${ROOT}public/barter/card.html`, "utf8");
  const home = readFileSync(`${ROOT}public/barter/index.html`, "utf8");
  const source = readFileSync(`${ROOT}public/barter/card.js`, "utf8");
  assert.equal(home.includes('href="/barter/card.html"'), true);
  assert.equal(home.includes('href="/#lore"'), true);
  assert.equal(page.includes('href="/#lore"'), true);
  assert.equal(home.includes("/lore/"), false);
  assert.equal(page.includes("/lore/"), false);
  assert.equal(page.includes(FOOTER), true);
  assert.equal(page.includes(WARMING), true);
  assert.equal(page.includes("Store opens soon"), true);
  assert.equal(page.includes("Show all"), true);
  assert.equal(page.includes("You are here"), true);
  assert.equal(page.includes("Practice Shield"), true);
  assert.equal(page.includes("Narrator Book"), true);
  assert.equal(page.includes("Barterer"), true);
  assert.equal(/<a\b[^>]*store/i.test(page), false);
  assert.equal(home.includes("/barterer.jpg"), true);
  assert.equal(home.includes('href="site.css"'), true);
  assert.equal(page.includes('href="site.css"'), true);
  assert.equal(home.includes('class="boss"'), true);
  assert.equal(page.includes('class="boss"'), true);
  assert.equal(home.includes(">Barter<"), true);
  assert.equal(page.includes(">Card<"), true);
  assert.equal(home.includes("Time to the close"), true);
  assert.equal(page.includes("Time to the close"), true);
  assert.equal(home.includes("Time to the call"), false);
  assert.equal(home.includes("No trades cleared tonight"), true);
  const site = readFileSync(`${ROOT}public/index.html`, "utf8");
  assert.equal(site.includes('href="/barter/site.css"'), true);
  assert.equal(site.includes('src="/barter/picks.js"'), true);
  assert.equal(site.includes('id="page-name"'), true);
  assert.equal(site.includes("Time to the close"), true);
  assert.equal(site.split('id="clock"').length, 2);
  const picks = readFileSync(`${ROOT}public/barter/picks.js`, "utf8");
  assert.equal(home.includes('src="picks.js"'), true);
  assert.equal(page.includes('src="picks.js"'), true);
  assert.equal(home.includes("Payouts open"), false);
  assert.equal(page.includes("Payouts open"), false);
  assert.equal(picks.includes('fetch("/lookup.json?t="'), true);
  assert.equal(picks.includes("book.send === true"), true);
  assert.equal(picks.includes("Picks live · Payouts open"), true);
  assert.equal(picks.includes("Picks live · KORE not open yet"), true);
  assert.equal(BANNED.test(picks), false);
  assert.equal(page.includes('fetch("/lookup.json")'), true);
  assert.equal(page.includes('fetch("/barter/ladder.json")'), true);
  assert.equal(page.includes('fetch("/barter/call-latest.json")'), true);
  assert.equal(page.includes("localStorage"), true);
  assert.equal(/<form/i.test(page), false);
  assert.equal(/keeta_[a-z0-9]{20,}/.test(page + source), false);
  const logic = source.replace(/const BANNED = .*/, "");
  assert.equal(BANNED.test(page + logic + home), false);
  assert.equal(closeLabel(nextClose("2026-10-16T21:49:00.000Z")), "8:00 PM ET");
  assert.equal(closeLabel(nextClose("2026-11-01T12:00:00.000Z")), "7:00 PM ET");
  assert.equal(updatedLabel("2026-10-16T21:18:29.945Z"), "Last updated October 16, 2026, 5:18 PM ET");
});
