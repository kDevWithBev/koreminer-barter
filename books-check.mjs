import { startMs } from "./ledger.mjs";
import { accounted, booksFromJson, booksToJson, createBooks, ingest, notePublished, payoutPlan, publicBooks, reconcile } from "./books.mjs";
import { readStaple } from "./chain.mjs";

const DAY = 86_400_000;
const open = startMs;
const kta = (n) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;
function check(name, ok) {
  if (!ok) throw new Error(name);
  console.log("ok", name);
}

const books = createBooks(open, kta(5));
check("2 KTA is reserved from the opening balance", books.share.reserve === kta(2));
check("the rest is operator fuel", books.operator === kta(3));
check("opening books match the balance", accounted(books) === kta(5));

const early = createBooks(open - DAY, kta(2));
check("fuel before open does not earn", ingest(early, {
  blocksHash: "soon",
  timeMs: open - 1000,
  deposits: [{ from: "alice", amount: kta(4) }],
  ownPicks: 0,
}) === "ok");
check("that fuel is operator fuel", early.operator === kta(4) && early.share.stake.size === 0);

ingest(books, {
  blocksHash: "a",
  timeMs: open,
  deposits: [{ from: "alice", amount: kta(10) }],
  ownPicks: 0,
});
ingest(books, {
  blocksHash: "b",
  timeMs: open + 1000,
  deposits: [{ from: "alice", amount: kta(10) }, { from: "bob", amount: kta(30) }],
  ownPicks: 0,
});
check("the same address is added", books.share.stake.get("alice") === kta(20));
check("bob is behind alice", books.share.lots[0].from === "alice" && books.share.lots[2].from === "bob");

notePublished(books, kta("0.006"), open + 2000);
check("a published pick waits for its staple", reconcile(books, accounted(books) - kta("0.006"), open + 2000, open + 2000) === "waiting-burn");
check("waiting does not burn twice", books.share.stake.get("alice") === kta(20));

check("the staple burns the oldest fuel", ingest(books, {
  blocksHash: "pick",
  timeMs: open + 3000,
  deposits: [],
  ownPicks: 1,
}) === "ok");
check("alice depth is the burn", books.share.depth.get("alice") === kta("0.006"));
check("alice still has the rest", books.share.stake.get("alice") === kta("19.994"));
check("the pick is not waiting", books.pendingDrops.length === 0);
check("books match after the burn", accounted(books) === kta("54.994"));

const saved = booksFromJson(booksToJson(books));
check("the books survive a restart", accounted(saved) === accounted(books) && saved.cursor === books.cursor);

accrueForward(saved);
const plan = payoutPlan(saved);
check("the plan cannot send", plan.send === false);
check("both miners are due", plan.rows.length === 2);
check("nothing is marked paid", saved.share.paid.size === 0);
const board = publicBooks(saved);
check("the lookup has a share", board.miners.alice.share === "0.3998" || board.miners.alice.fuel.startsWith("19.994"));
check("bob's share is larger", Number(board.miners.bob.share) > Number(board.miners.alice.share));

const healed = createBooks(open, kta(10));
notePublished(healed, kta(1), open);
const status = reconcile(healed, kta(9), open + 1000, open + burnWait());
check("a lost staple is healed once", status === "ok");
check("the healed burn is not still pending", healed.pendingDrops.length === 0);
check("healing burns operator fuel first when no miner is in", healed.operator === kta(7));

const staple = readStaple({
  voteStaple: {
    blocksHash: { toString: () => "hash" },
    timestamp: () => new Date(open),
    blocks: [
      { account: id("miner"), operations: [{ type: 0, to: id(intake()), token: id("kta"), amount: kta(4) }] },
      { account: id(intake()), operations: [{ type: 0, to: id(sink()), token: id("kta"), amount: 1n }] },
      { account: id("miner"), operations: [{ type: 7, to: id(intake()), token: id("kore"), amount: 5n }] },
    ],
  },
}, "kta");
check("a user send is a deposit", staple.deposits.length === 1 && staple.deposits[0].from === "miner");
check("the shaft's own pick is counted", staple.ownPicks === 1);
check("another token is ignored", staple.deposits.every((item) => item.amount === kta(4)));

function accrueForward(state) {
  ingest(state, { blocksHash: "day", timeMs: open + DAY, deposits: [], ownPicks: 0 });
}
function burnWait() { return 120_000; }
function id(value) { return { publicKeyString: { toString: () => value } }; }
function intake() { return "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa"; }
function sink() { return "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq"; }

console.log("books ok");
