import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attributeDeposits, BRIDGE_CONTRACT, chooseSender, clearCache, creditStaples, decodeDepositId, ENTRYPOINT, KTA, liveIo, LookupFailed, resolveTx, shaftDestination, SHAFT } from "./base-credit.mjs";
import { accounted, booksFromJson, booksToJson, createBooks, ingest, notePublished, publicBooks } from "./books.mjs";
import { BRIDGE } from "./claim.mjs";
import { isErc6492, signatureOwns, VALIDATOR } from "./claim-sig.mjs";
import { readStaple } from "./chain.mjs";
import { startMs } from "./ledger.mjs";
import { applyLinks, checkLink, commitLink, linkMessage, readLinks, saveLinks } from "./links.mjs";
import { dryRunText } from "./pay-dry.mjs";
import { createShare, deposit } from "./share.mjs";

const kta = (n) => BigInt(n) * 10n ** 18n;
const open = startMs;
const TX1 = "0xff32a5f5979a79296bc9f73bc68ae2c87055710fe46d6ba783837a6eb8c10ddd";
const TX2 = "0xb804bda131ceb7a5d7b5026e1a5309901836b699cb07eab3115b467789dc821f";
const WALLET = "0x1be8be2782214ef91bc1b970b9b1a55fc7cc0ee0";
const ORIGIN = "0x2db970e13441b59c9d95f8eb642b406ec1a8a57f";
const ROUTER = "0x4f6f91599858bf0d19fabcf2c5d591fe13f7c059";
const BUNDLER = "0x1278c1e48e3c9548a5d9f2b16dc27ed311b0697c";
const SWAP_TO = "0x7e07a9148e9149e430c6412b79a675028595ff1f";
const BRIDGE_TX = "0x" + "ab".repeat(32);
const sizes = {
  [WALLET]: 61,
  [BUNDLER]: 0,
  [ENTRYPOINT]: 23689,
  [ORIGIN]: 0,
  [ROUTER]: 20813,
  [SWAP_TO]: 5577,
  [SHAFT]: 0,
};
const keeta1 = `keeta_${"a".repeat(50)}`;
const keeta2 = `keeta_${"b".repeat(50)}`;
let count = 0;

function check(name, ok) {
  count += 1;
  if (!ok) throw new Error(name);
  console.log("ok", name);
}

function fileHash(name) {
  const path = fileURLToPath(new URL(name, import.meta.url));
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

check("pay.mjs was not edited", fileHash("./pay.mjs") === "516019e1fe076688e2c6001141918a63");
check("share.mjs was not edited", fileHash("./share.mjs") === "a47c7221087e6728367f83845db06a36");

check("the 11 KTA tx credits the smart wallet", chooseSender({
  transferFrom: WALLET,
  txFrom: BUNDLER,
  txTo: ENTRYPOINT,
  codeSize: (addr) => sizes[addr] ?? 0,
}) === WALLET);
check("the router tx credits the originating wallet", chooseSender({
  transferFrom: ROUTER,
  txFrom: ORIGIN,
  txTo: SWAP_TO,
  codeSize: (addr) => sizes[addr] ?? 0,
}) === ORIGIN);
check("the shaft address is never credited", chooseSender({
  transferFrom: SHAFT,
  txFrom: ORIGIN,
  txTo: SWAP_TO,
  codeSize: (addr) => sizes[addr] ?? 0,
}) === "");
check("a relayer contract is never credited", chooseSender({
  transferFrom: ROUTER,
  txFrom: ENTRYPOINT,
  txTo: SWAP_TO,
  codeSize: (addr) => sizes[addr] ?? 0,
}) === "");

clearCache();
let lookups = 0;
const io1 = {
  async tx(hash) {
    lookups += 1;
    return hash === TX1 ? {
      hash: TX1, from: BUNDLER, to: ENTRYPOINT, blockNumber: "0x324c4aa", transactionIndex: "0x31",
    } : null;
  },
  async transfers() {
    return [{
      transactionHash: TX1, blockNumber: "0x324c4aa", transactionIndex: "0x31", logIndex: "0xf6", from: WALLET, to: SHAFT,
    }];
  },
  async code(addr) { return sizes[addr] ?? 0; },
};
check("example tx 0xff32 resolves to 0x1be8...0ee0", await resolveTx(TX1, io1) === WALLET);
check("a tx is looked up once", lookups === 1 && await resolveTx(TX1, io1) === WALLET);

clearCache();
const io2 = {
  async tx(hash) {
    if (hash === TX2) return { hash: TX2, from: ORIGIN, to: SWAP_TO, blockNumber: "0x3218d27", transactionIndex: "0x1e" };
    return null;
  },
  async transfers() {
    return [{
      transactionHash: TX2, blockNumber: "0x3218d27", transactionIndex: "0x1e", logIndex: "0x68", from: ROUTER, to: SHAFT,
    }];
  },
  async code(addr) { return sizes[addr] ?? 0; },
};
check("example tx 0xb804 resolves to 0x2db9...a57f", await resolveTx(TX2, io2) === ORIGIN);

clearCache();
const ioBefore = {
  async tx(hash) {
    if (hash === BRIDGE_TX) return { hash: BRIDGE_TX, from: BUNDLER, to: "0x1c24a0fb7bcf2154a9d37b7b3aa443bc63fcc698", blockNumber: "0x100", transactionIndex: "0x20" };
    if (hash === TX2) return { hash: TX2, from: ORIGIN, to: SWAP_TO, blockNumber: "0x100", transactionIndex: "0x1e" };
    return null;
  },
  async transfers() {
    return [{
      transactionHash: TX2, blockNumber: "0x100", transactionIndex: "0x1e", logIndex: "0x10", from: ROUTER, to: SHAFT,
    }];
  },
  async code(addr) { return sizes[addr] ?? 0; },
};
check("a transfer just before the bridge tx credits the swap wallet", await resolveTx(BRIDGE_TX, ioBefore) === ORIGIN);

function creditIo({ t, amount, timeMs, sweep, buy, transferFrom, txFrom, txTo, logIndex, block = 1000n, transfers }) {
  const dest = shaftDestination();
  const sweepBlock = `0x${block.toString(16)}`;
  const buyBlock = `0x${(block - 1n).toString(16)}`;
  const rows = transfers ?? [{
    transactionHash: buy, blockNumber: buyBlock, transactionIndex: "0x5", logIndex, from: transferFrom, to: SHAFT, amount,
  }];
  return {
    async latest() {
      return { number: block + 15n, time: Math.floor(timeMs / 1000) + 30 };
    },
    async deposits() {
      return [{
        id: t, sender: SHAFT, amount, recipient: dest, transactionHash: sweep,
        blockNumber: sweepBlock, transactionIndex: "0x10", logIndex: "0x1",
      }];
    },
    async tx(hash) {
      const key = String(hash || "").toLowerCase();
      if (key === sweep) return { hash: key, from: "0x22cbcd0e87eb389daa0d241d01d345d980d57db9", to: BRIDGE_CONTRACT, blockNumber: sweepBlock, transactionIndex: "0x10" };
      if (key === buy) return { hash: key, from: txFrom, to: txTo, blockNumber: buyBlock, transactionIndex: "0x5" };
      return null;
    },
    async transfers() { return rows; },
    async code(addr) { return sizes[String(addr).toLowerCase()] ?? 0; },
  };
}

const idWallet = `0x${"ab".repeat(32)}`;
const idOrigin = `0x${"cd".repeat(32)}`;
const sweepWallet = `0x${"11".repeat(32)}`;
const buyWallet = `0x${"22".repeat(32)}`;
const sweepOrigin = `0x${"33".repeat(32)}`;
const buyOrigin = `0x${"44".repeat(32)}`;
const lump = createBooks(open, kta(2));
deposit(lump.share, BRIDGE, kta(23), open);
const before = lump.share.stake.get(BRIDGE);
const unresolved = await attributeDeposits({
  blocksHash: "missing",
  timeMs: open + 1000,
  deposits: [{ from: BRIDGE, amount: kta(11), block: "block-missing" }, { from: "keeta_alice", amount: kta(4), external: "" }],
}, { links: {} });
check("a delivery with no deposit id is unresolved", unresolved.retry === false && unresolved.staple.deposits[0].credit === false && unresolved.staple.deposits[0].t === "");
check("a native deposit is left alone", unresolved.staple.deposits[1].from === "keeta_alice");
ingest(lump, unresolved.staple);
check("unresolved fuel is not credited to the bridge", lump.share.stake.get(BRIDGE) === before);
check("unresolved fuel is not credited to a wallet", ![...lump.share.stake.keys()].some((key) => key.startsWith("base:")));
check("an unresolved entry keeps the block, id, amount, and time", lump.unresolved.length === 1
  && lump.unresolved[0].block === "block-missing"
  && lump.unresolved[0].t === ""
  && lump.unresolved[0].amount === kta(11).toString()
  && lump.unresolved[0].time === open + 1000
  && lump.parked === kta(11));
check("the books still balance with nobody credited", accounted(lump) === kta(2) + kta(23) + kta(11) + kta(4));

const named = await attributeDeposits({
  blocksHash: "named",
  timeMs: open + 2000,
  deposits: [{ from: BRIDGE, amount: kta(11), external: idWallet, block: "block-named" }],
}, {
  links: {},
  now: open + 2000,
  io: creditIo({
    t: idWallet, amount: kta(11), timeMs: open + 2000, sweep: sweepWallet, buy: buyWallet,
    transferFrom: WALLET, txFrom: BUNDLER, txTo: ENTRYPOINT, logIndex: "0xf6",
  }),
});
ingest(lump, named.staple);
check("a new delivery does not add to the old bridge lump", named.retry === false && lump.share.stake.get(BRIDGE) === before);
check("the new delivery is held under the real base address", lump.share.stake.get(`base:${WALLET}`) === kta(11));
check("the transfer is used once", lump.used.includes(`${buyWallet}:0xf6`));
const view = publicBooks(lump);
check("the old held entry stays labeled with the shaft address", view.held.some((row) => row.base === SHAFT));
check("the new held entry uses the real sender", view.held.some((row) => row.base === WALLET));
check("a base key is not on the miner board", view.board.every((row) => !row.from.startsWith("base:") && row.from !== BRIDGE));

const linkedKeeta = keeta1;
const linked = await attributeDeposits({
  blocksHash: "linked",
  timeMs: open + 3000,
  deposits: [{ from: BRIDGE, amount: kta(3), external: idOrigin }],
}, {
  links: { [ORIGIN]: { keeta: linkedKeeta } },
  now: open + 3000,
  io: creditIo({
    t: idOrigin, amount: kta(3), timeMs: open + 3000, sweep: sweepOrigin, buy: buyOrigin,
    transferFrom: ROUTER, txFrom: ORIGIN, txTo: SWAP_TO, logIndex: "0x68",
  }),
});
ingest(lump, linked.staple);
check("a linked sender is credited to that keeta address", linked.retry === false && lump.share.stake.get(linkedKeeta) === kta(3));
check("a linked sender is not also stored as base", (lump.share.stake.get(`base:${ORIGIN}`) ?? 0n) === 0n);

const again = await attributeDeposits({
  blocksHash: "again",
  timeMs: open + 4000,
  deposits: [{ from: BRIDGE, amount: kta(11), external: idWallet, block: "block-again" }],
}, {
  books: lump,
  now: open + 4000,
  io: creditIo({
    t: idWallet, amount: kta(11), timeMs: open + 4000, sweep: sweepWallet, buy: buyWallet,
    transferFrom: WALLET, txFrom: BUNDLER, txTo: ENTRYPOINT, logIndex: "0xf6",
  }),
});
ingest(lump, again.staple);
check("a transfer already used is parked", again.retry === false && again.staple.deposits[0].credit === false && lump.parked === kta(22));
check("a used transfer is not credited twice", lump.share.stake.get(`base:${WALLET}`) === kta(11));

const mismatch = await attributeDeposits({
  blocksHash: "mismatch",
  timeMs: open + 5000,
  deposits: [{ from: BRIDGE, amount: kta(11), external: idOrigin, block: "block-mismatch" }],
}, {
  now: open + 5000,
  io: creditIo({
    t: idOrigin, amount: kta(11), timeMs: open + 5000, sweep: sweepOrigin, buy: buyOrigin,
    transferFrom: ROUTER, txFrom: ORIGIN, txTo: SWAP_TO, logIndex: "0x69",
    transfers: [{
      transactionHash: buyOrigin, blockNumber: "0x3e7", transactionIndex: "0x5", logIndex: "0x69",
      from: ROUTER, to: SHAFT, amount: kta(3),
    }],
  }),
});
check("a different transfer amount is parked", mismatch.retry === false && mismatch.staple.deposits[0].credit === false);

const doubled = await attributeDeposits({
  blocksHash: "doubled",
  timeMs: open + 6000,
  deposits: [{ from: BRIDGE, amount: kta(5), external: idWallet, block: "block-doubled" }],
}, {
  now: open + 6000,
  io: creditIo({
    t: idWallet, amount: kta(5), timeMs: open + 6000, sweep: sweepWallet, buy: buyWallet,
    transferFrom: WALLET, txFrom: BUNDLER, txTo: ENTRYPOINT, logIndex: "0x10",
    transfers: [
      { transactionHash: buyWallet, blockNumber: "0x3e7", transactionIndex: "0x5", logIndex: "0x10", from: WALLET, to: SHAFT, amount: kta(5) },
      { transactionHash: buyOrigin, blockNumber: "0x3e6", transactionIndex: "0x4", logIndex: "0x11", from: ROUTER, to: SHAFT, amount: kta(5) },
    ],
  }),
});
check("two unused matches are parked", doubled.retry === false && doubled.staple.deposits[0].credit === false);

const banned = await attributeDeposits({
  blocksHash: "banned",
  timeMs: open + 7000,
  deposits: [{ from: BRIDGE, amount: kta(6), external: idOrigin, block: "block-banned" }],
}, {
  now: open + 7000,
  io: creditIo({
    t: idOrigin, amount: kta(6), timeMs: open + 7000, sweep: sweepOrigin, buy: buyOrigin,
    transferFrom: SHAFT, txFrom: ORIGIN, txTo: SWAP_TO, logIndex: "0x12",
  }),
});
check("a banned sender is parked", banned.retry === false && banned.staple.deposits[0].credit === false);

const stranger = `0x${"99".repeat(20)}`;
const strangerId = `0x${"ee".repeat(32)}`;
const strangerWhen = open + 8000;
const strangerHead = 500n;
let windowTo = -1n;
let askedTx = false;
const strangerBooks = createBooks(open, kta(2));
strangerBooks.cursor = "stranger-old";
const strangerPass = await creditStaples(strangerBooks, [{
  blocksHash: "stranger",
  timeMs: strangerWhen,
  deposits: [{ from: BRIDGE, amount: kta(4), external: strangerId, block: "block-stranger" }],
}], {
  newest: "stranger-new",
  ingest,
  now: strangerWhen,
  io: {
    async latest() {
      return { number: strangerHead, time: Math.floor(strangerWhen / 1000) + 30 };
    },
    async deposits(_from, to) {
      windowTo = to;
      return [{
        id: strangerId,
        sender: stranger,
        amount: kta(4),
        recipient: shaftDestination(),
        transactionHash: sweepWallet,
        blockNumber: "0x1f4",
        transactionIndex: "0x1",
        logIndex: "0x1",
      }];
    },
    async tx() { askedTx = true; return null; },
    async transfers() { askedTx = true; return []; },
    async code() { return 0; },
  },
});
check("a deposit from another sender is parked without a retry", strangerPass === "ok"
  && askedTx === false
  && strangerBooks.cursor === "stranger-new"
  && strangerBooks.parked === kta(4)
  && strangerBooks.unresolved.length === 1
  && strangerBooks.unresolved[0].t === strangerId
  && strangerBooks.unresolved[0].block === "block-stranger"
  && (strangerBooks.share.stake.get(`base:${stranger}`) ?? 0n) === 0n);
check("the window end is never above the head", windowTo === strangerHead && windowTo <= strangerHead);

const burnBooks = createBooks(open, kta(2));
deposit(burnBooks.share, "keeta_alice", kta(1), open);
burnBooks.parked = kta(10);
notePublished(burnBooks, kta(1), open);
check("a burn that fits does not draw from parked", ingest(burnBooks, {
  blocksHash: "burn-fit", timeMs: open + 1000, deposits: [], ownPicks: 1,
}) === "ok" && burnBooks.parked === kta(10) && burnBooks.share.stake.get("keeta_alice") === 0n);
const burnHalt = createBooks(open, kta(2));
deposit(burnHalt.share, "keeta_alice", kta(1), open);
burnHalt.parked = kta(10);
notePublished(burnHalt, kta(2), open);
check("a burn larger than stake and operator halts", ingest(burnHalt, {
  blocksHash: "burn-halt", timeMs: open + 1000, deposits: [], ownPicks: 1,
}) === "halt-reserve" && burnHalt.parked === kta(10) && burnHalt.share.stake.get("keeta_alice") === kta(1));
check("parked fuel still counts in the books", accounted(burnHalt) === kta(2) + kta(1) + kta(10));

const share = createShare(open);
share.reserve = kta(2);
deposit(share, BRIDGE, kta(23), open);
deposit(share, `base:${WALLET}`, kta(11), open);
const bridgeBefore = share.stake.get(BRIDGE);
const books = { share, operator: 0n, parked: 0n, unresolved: [] };
check("linking moves only the base key", applyLinks(books, { [WALLET]: { keeta: keeta2 } }) === true);
check("the bridge lump stays put", share.stake.get(BRIDGE) === bridgeBefore && bridgeBefore === kta(23));
check("the linked keeta receives the base fuel", share.stake.get(keeta2) === kta(11));
check("the base key is gone", (share.stake.get(`base:${WALLET}`) ?? 0n) === 0n);

const now = Date.parse("2026-10-17T12:00:00Z");
const first = checkLink({ base: WALLET, keeta: keeta1, nonce: "nonce-1234567890abcd", date: "2026-10-17" }, now);
check("the link message is exact", first.ok === true && first.message === linkMessage({
  base: WALLET, keeta: keeta1, nonce: "nonce-1234567890abcd", date: "2026-10-17",
}) && first.message === `Link Base ${WALLET} to Keeta ${keeta1} for Koreminer, nonce nonce-1234567890abcd, 2026-10-17`);
check("the shaft address cannot be linked", checkLink({
  base: SHAFT, keeta: keeta1, nonce: "nonce-1234567890abcd", date: "2026-10-17",
}, now).reason === "bad-base");
let links = commitLink({}, first);
const second = checkLink({ base: WALLET, keeta: keeta2, nonce: "nonce-abcdef0123456789", date: "2026-10-17" }, now);
const bad = await signatureOwns({
  message: second.message,
  signature: `0x${"11".repeat(65)}`,
  base: WALLET,
  recover: () => `0x${"22".repeat(20)}`,
  call: async () => "0x",
});
check("a bad signature is rejected", bad === false);
check("a bad signature does not relink", links[WALLET].keeta === keeta1);
const good = await signatureOwns({
  message: second.message,
  signature: `0x${"11".repeat(65)}`,
  base: WALLET,
  recover: () => WALLET,
  call: async () => "0x",
});
check("a new signature can relink", good === true);
links = commitLink(links, second);
check("relink keeps one keeta for that base", links[WALLET].keeta === keeta2 && Object.keys(links).length === 1);

const magic = "6492".repeat(16);
const wrapped = `0x${"ab".repeat(40)}${magic}`;
let validatorTo = "";
const counterfactual = await signatureOwns({
  message: second.message,
  signature: wrapped,
  base: WALLET,
  call: async (to, data) => {
    validatorTo = to;
    return typeof data === "string" && data.startsWith("0x") ? `0x${"0".repeat(63)}1` : "0x";
  },
});
check("an undeployed wallet is checked with erc-6492", isErc6492(wrapped) && validatorTo === VALIDATOR && counterfactual === true);
let walletTo = "";
const smart = await signatureOwns({
  message: second.message,
  signature: `0x${"11".repeat(65)}`,
  base: WALLET,
  recover: () => `0x${"22".repeat(20)}`,
  call: async (to, data) => {
    walletTo = to;
    return String(data).startsWith("0x1626ba7e") ? "0x1626ba7e" : "0x";
  },
});
check("a deployed smart wallet is checked with erc-1271", walletTo === WALLET && smart === true);

const dir = mkdtempSync(join(tmpdir(), "kore-links-"));
const linksPath = join(dir, "links.json");
saveLinks(linksPath, { [WALLET]: { keeta: keeta1, nonce: first.nonce, date: first.date } });
saveLinks(linksPath, links);
check("a link write keeps a backup", readLinks(`${linksPath}.bak`)[WALLET].keeta === keeta1);
check("the new link replaces the backup", readLinks(linksPath)[WALLET].keeta === keeta2);

const intake = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const staple = readStaple({
  voteStaple: {
    blocksHash: { toString: () => "hash" },
    timestamp: () => new Date(open),
    blocks: [{
      account: { publicKeyString: { toString: () => BRIDGE } },
      operations: [{
        type: 0,
        to: { publicKeyString: { toString: () => intake } },
        token: { publicKeyString: { toString: () => "kta" } },
        amount: kta(11),
        external: TX1,
      }],
    }],
  },
}, "kta");
check("a bridge delivery keeps its base tx", staple.deposits[0].external === TX1 && staple.deposits[0].from === BRIDGE);

const dryBooks = createBooks(open, kta(2));
deposit(dryBooks.share, "keeta_alice", kta(10), open);
deposit(dryBooks.share, "keeta_bob", kta(30), open);
deposit(dryBooks.share, BRIDGE, kta(23), open);
deposit(dryBooks.share, `base:${SHAFT}`, kta(5), open);
deposit(dryBooks.share, `base:${WALLET}`, kta(11), open);
deposit(dryBooks.share, ORIGIN, kta(7), open);
const dryPath = join(dir, "books.json");
const copyPath = join(dir, "books.copy.json");
writeFileSync(dryPath, JSON.stringify(booksToJson(dryBooks)));
copyFileSync(dryPath, copyPath);
const beforeBytes = readFileSync(copyPath);
const text = dryRunText(booksFromJson(JSON.parse(readFileSync(copyPath, "utf8"))));
check("the dry run does not write the copy", readFileSync(copyPath).equals(beforeBytes));
check("the dry run sends nothing and skips shaft, bridge, and 0x", text.includes("DRY RUN. Nothing will be sent.")
  && text.includes("no shaft 0xfe6d: ok")
  && text.includes("no bridge: ok")
  && text.includes("no 0x: ok")
  && text.includes("sum check: ok")
  && !text.includes(BRIDGE)
  && !text.includes(SHAFT)
  && !text.includes(ORIGIN));
console.log(text.trimEnd());

const extB26 = "MIIBVQIBAaGB0DCBzQSBynicFcxRboMwDADQu/ibj9hO4pi/QOEaU8Kg6lZUwoBVq7j71HeA94IE9Qu+x3FLHynl/UvoL6/P9FuKLLc85WPMZT/mtLr7dh0ed7LrjwyFhvQpReZxma/D8zbtU3lHG9RA4gMKGR/UqWMjTi1hIGetsYiEquwskTeoTMjKxN4H5SBeQyBm9MrkxYhDOM8K8rt+QG0qWKCGFjEixS4qBhf71nW9sDaWGI0Y6a2NZFujwTYcG9eThksnhjCiOI0NnBUcUOP5D6yfRDKifTB7AgEDgCIAA0T/WQxuC0IfegJQ1IGFKsBHq5mE5euRl8UNCAP8PsI9BglghkgBZQMEAggGBSuBBAAKBECwwYCK+Pg9DQfYYE4d3WYmsQhVD/rwl3bqfQ8GY1lkpy7FbJHI9CXG3js3yWyX7cgBqxJkzUMezB3a1Cat+Ayh";
const ext440 = "MIIBVQIBAaGB0DCBzQSBynicFcxRboMwDADQu/ibD8eJ7Zg/Nsg1poRB1a2owIBVq7j71HeA94QM9RO+h2HLHzmX/Uvpr6yP/LssOl/LWI6hLPsx5ZVv26W/3yisP9ov1OdPXXQa5unSP67jPi6vaIMaGD0qOnPCrIKKFM0zOxNDhyhs5H30KN7ETIMpmQYiJXJCMbDzFoNZRAkM51lBedV3qLGCGWpIIcUuYWrMNeK6qGitUEytdxoi+SCNdtF8y9p2Qk2KwiiW3lu2N2WBs4IDanf+A7lKRHWifTB7AgEDgCIAA0T/WQxuC0IfegJQ1IGFKsBHq5mE5euRl8UNCAP8PsI9BglghkgBZQMEAggGBSuBBAAKBEBqK3CRgdlfbFzgNA+X7bZ2USUwAcDzVzgiLHxF2cvAM0i8avMAXPyE7/u/vf884rVHyuY+9FnInaklkHsqzvO+";
const tB26 = "0x3d334c766f40bdd4ee99c68070c36343560501a9e8b47d7f3e93bd65bb54351f";
const t440 = "0x6f38c3891df6d307372cc870e77d36504f49f6eda03a192a54aeb6773ef02ae5";
const hashB26 = "B26B6A8C3E7B772C83FF61EDCBF33EF33A38553282F903AEB7089789228FF15F";
const hash440 = "440DA3680643C1FA4645E6DAA5A28017C6C0F990737C73C17936FDC149149488";
const timeB26 = Date.parse("2026-10-13T00:11:30.387Z");
const time440 = Date.parse("2026-10-17T21:18:48.510Z");
const amtB26 = BigInt("0x14405d3aa5c9a5b8c");
const amt440 = BigInt("0x98a7d9b8314c0000");
const sweepB26 = "0x56acd8b2206388469fa8732de83d43f665754d48a5c5c3f977406866ac51aaa6";
const buyB26 = "0xb804bda131ceb7a5d7b5026e1a5309901836b699cb07eab3115b467789dc821f";
const sweep440 = "0x5ccda63f3de8f01917f4039944b4ed97471a61b6c7f24dd4808b6ce9b57f459a";
const buy440 = "0xff32a5f5979a79296bc9f73bc68ae2c87055710fe46d6ba783837a6eb8c10ddd";
const depositTopic = "0x4799b8d532da22980c5d2274e923177e9d9676df4fd980af8bb5f854a2c4b9c6";
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const liveDeposits = [
  {
    address: BRIDGE_CONTRACT,
    topics: [depositTopic, "0x000000000000000000000000000000000000000000000000000000000000319a", `0x${SHAFT.slice(2).padStart(64, "0")}`, `0x${KTA.slice(2).padStart(64, "0")}`],
    data: "0x3d334c766f40bdd4ee99c68070c36343560501a9e8b47d7f3e93bd65bb54351f00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000014405d3aa5c9a5b8c0000000000000000000000000000000000000000000000000000000000000022000379b49f38515c914d2ec5e1dbf10fe885b7ef0b676a06361083fa67da41d2b62c000000000000000000000000000000000000000000000000000000000000",
    transactionHash: sweepB26, blockNumber: "0x3218d28", transactionIndex: "0xa0", logIndex: "0x1bc",
  },
  {
    address: BRIDGE_CONTRACT,
    topics: [depositTopic, "0x0000000000000000000000000000000000000000000000000000000000003201", `0x${SHAFT.slice(2).padStart(64, "0")}`, `0x${KTA.slice(2).padStart(64, "0")}`],
    data: "0x6f38c3891df6d307372cc870e77d36504f49f6eda03a192a54aeb6773ef02ae5000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000098a7d9b8314c00000000000000000000000000000000000000000000000000000000000000000022000379b49f38515c914d2ec5e1dbf10fe885b7ef0b676a06361083fa67da41d2b62c000000000000000000000000000000000000000000000000000000000000",
    transactionHash: sweep440, blockNumber: "0x324c4ab", transactionIndex: "0x46", logIndex: "0x104",
  },
];
const liveTransfers = [
  {
    address: KTA,
    topics: [transferTopic, "0x0000000000000000000000004f6f91599858bf0d19fabcf2c5d591fe13f7c059", `0x${SHAFT.slice(2).padStart(64, "0")}`],
    data: "0x0000000000000000000000000000000000000000000000014405d3aa5c9a5b8c",
    transactionHash: buyB26, blockNumber: "0x3218d27", transactionIndex: "0x1e", logIndex: "0x68",
  },
  {
    address: KTA,
    topics: [transferTopic, "0x0000000000000000000000001be8be2782214ef91bc1b970b9b1a55fc7cc0ee0", `0x${SHAFT.slice(2).padStart(64, "0")}`],
    data: "0x00000000000000000000000000000000000000000000000098a7d9b8314c0000",
    transactionHash: buy440, blockNumber: "0x324c4aa", transactionIndex: "0x31", logIndex: "0xf6",
  },
];
const liveTx = {
  [sweepB26]: { from: "0x22cbcd0e87eb389daa0d241d01d345d980d57db9", to: BRIDGE_CONTRACT, blockNumber: "0x3218d28", transactionIndex: "0xa0" },
  [buyB26]: { from: ORIGIN, to: SWAP_TO, blockNumber: "0x3218d27", transactionIndex: "0x1e" },
  [sweep440]: { from: "0x32d2576a94064c796e4574fc2477f56052c01396", to: BRIDGE_CONTRACT, blockNumber: "0x324c4ab", transactionIndex: "0x46" },
  [buy440]: { from: BUNDLER, to: ENTRYPOINT, blockNumber: "0x324c4aa", transactionIndex: "0x31" },
};
check("both externals decode to the deposit ids", decodeDepositId(extB26) === tB26 && decodeDepositId(ext440) === t440);
check("the shaft destination is the intake prefix", shaftDestination() === "000379b49f38515c914d2ec5e1dbf10fe885b7ef0b676a06361083fa67da41d2b62c");

function bridgeRow({ blocksHash, block, timeMs, amount, external }) {
  return {
    voteStaple: {
      blocksHash: { toString: () => blocksHash },
      timestamp: () => new Date(timeMs),
      blocks: [{
        hash: { toString: () => block },
        account: { publicKeyString: { toString: () => BRIDGE } },
        operations: [{
          type: 0,
          to: { publicKeyString: { toString: () => intake } },
          token: { publicKeyString: { toString: () => "kta" } },
          amount,
          external,
        }],
      }],
    },
  };
}
const readB26 = readStaple(bridgeRow({
  blocksHash: "staple-b26", block: hashB26, timeMs: timeB26, amount: amtB26, external: extB26,
}), "kta");
const read440 = readStaple(bridgeRow({
  blocksHash: "staple-440", block: hash440, timeMs: time440, amount: amt440, external: ext440,
}), "kta");
check("readStaple keeps both raw externals", readB26.deposits[0].external === extB26 && read440.deposits[0].external === ext440
  && readB26.deposits[0].block === hashB26 && read440.deposits[0].block === hash440);

let tipNumber = 0n;
let tipTime = 0;
let rpcMode = "live";
let rpcCalls = [];
let sawSignal = false;
let sawAgent = false;
let maxLogTo = 0n;
let depositTopics = null;
const originalFetch = globalThis.fetch;
function rpcJson(result) {
  return { json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
}
function installRpc() {
  globalThis.fetch = async (_url, init) => {
    sawSignal = sawSignal || init?.signal instanceof AbortSignal;
    sawAgent = sawAgent || init?.headers?.["user-agent"] === "koreminer/1.0";
    const request = JSON.parse(init.body);
    rpcCalls.push(request.method);
    if (rpcMode === "down") throw new Error("down");
    if (request.method === "eth_getBlockByNumber") return rpcJson({ number: `0x${tipNumber.toString(16)}`, timestamp: `0x${tipTime.toString(16)}` });
    if (request.method === "eth_getTransactionByHash") {
      if (rpcMode === "nulltx") return rpcJson(null);
      return rpcJson(liveTx[String(request.params[0]).toLowerCase()] ?? null);
    }
    if (request.method === "eth_getCode") {
      const size = sizes[String(request.params[0]).toLowerCase()] ?? 0;
      return rpcJson(size ? `0x${"ab".repeat(size)}` : "0x");
    }
    if (request.method === "eth_getLogs") {
      if (rpcMode === "empty") return rpcJson([]);
      const filter = request.params[0];
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      if (to > maxLogTo) maxLogTo = to;
      const address = String(filter.address).toLowerCase();
      const topic0 = String(filter.topics?.[0] || "").toLowerCase();
      if (address === BRIDGE_CONTRACT && depositTopics === null) depositTopics = filter.topics;
      const pool = address === BRIDGE_CONTRACT ? liveDeposits : address === KTA ? liveTransfers : [];
      return rpcJson(pool.filter((log) => {
        const block = BigInt(log.blockNumber);
        return block >= from && block <= to && topic0 === String(log.topics[0]).toLowerCase();
      }));
    }
    return rpcJson(null);
  };
}
function useTip(timeMs, sweepBlock) {
  tipTime = Math.floor(timeMs / 1000) + 30;
  tipNumber = sweepBlock + 15n;
}
const claimdSrc = readFileSync(fileURLToPath(new URL("./claimd.mjs", import.meta.url)), "utf8");
check("claimd eth_call aborts after 10s", claimdSrc.includes("AbortSignal.timeout(10000)"));
installRpc();
try {
  clearCache();
  useTip(timeB26, 0x3218d28n);
  const liveBooks = createBooks(timeB26, kta(2));
  liveBooks.cursor = "cursor-before";
  const first = await creditStaples(liveBooks, [readB26], { newest: "cursor-b26", ingest, now: timeB26 + 30_000 });
  check("B26B resolves through the mocked deposit to 0x2db970e1", first === "ok" && liveBooks.share.stake.get(`base:${ORIGIN}`) === amtB26);
  check("B26B uses the buy transfer once", liveBooks.used.includes(`${buyB26}:0x68`) && liveBooks.cursor === "cursor-b26");
  check("B26B does not credit the bridge", (liveBooks.share.stake.get(BRIDGE) ?? 0n) === 0n);
  const ktaTopic = `0x${KTA.slice(2).padStart(64, "0")}`;
  check("deposit search is the bridge, the event, and the token", Array.isArray(depositTopics)
    && depositTopics[0] === depositTopic
    && depositTopics[2] == null
    && String(depositTopics[3]).toLowerCase() === ktaTopic);
  check("a live window ends at the head", maxLogTo <= tipNumber);
  clearCache();
  useTip(time440, 0x324c4abn);
  const second = await creditStaples(liveBooks, [read440], { newest: "cursor-440", ingest, now: time440 });
  check("440DA resolves through the mocked deposit to 0x1be8be27", second === "ok" && liveBooks.share.stake.get(`base:${WALLET}`) === amt440);
  check("440DA uses the buy transfer once", liveBooks.used.includes(`${buy440}:0xf6`) && liveBooks.cursor === "cursor-440");
  check("base lookups send a 10s abort and a user agent", sawSignal === true && sawAgent === true);

  rpcMode = "down";
  const downRow = readStaple(bridgeRow({
    blocksHash: "staple-down", block: hashB26, timeMs: timeB26, amount: amtB26, external: extB26,
  }), "kta");
  const parkedBefore = liveBooks.parked;
  const unresolvedBefore = liveBooks.unresolved.length;
  const down = await creditStaples(liveBooks, [downRow], { newest: "cursor-down", ingest, now: time440 + 1000 });
  check("an RPC failure retries", down === "retry");
  check("an RPC failure does not park or move the cursor", liveBooks.cursor === "cursor-440"
    && liveBooks.parked === parkedBefore && liveBooks.unresolved.length === unresolvedBefore);

  rpcMode = "nulltx";
  clearCache();
  rpcCalls = [];
  const nullRow = readStaple(bridgeRow({
    blocksHash: "staple-null", block: hash440, timeMs: time440, amount: amt440, external: ext440,
  }), "kta");
  const nulled = await creditStaples(liveBooks, [nullRow], { newest: "cursor-null", ingest, now: time440 + 2000 });
  const nullFetches = rpcCalls.filter((method) => method === "eth_getTransactionByHash").length;
  clearCache();
  const nulledAgain = await creditStaples(liveBooks, [nullRow], { newest: "cursor-null", ingest, now: time440 + 2000 });
  const nullFetchesAgain = rpcCalls.filter((method) => method === "eth_getTransactionByHash").length;
  check("a null tx retries and is not cached", nulled === "retry" && nulledAgain === "retry" && nullFetchesAgain > nullFetches);
  check("a null tx does not park or move the cursor", liveBooks.cursor === "cursor-440" && liveBooks.unresolved.length === unresolvedBefore);

  rpcMode = "empty";
  clearCache();
  const emptyRow = readStaple(bridgeRow({
    blocksHash: "staple-empty", block: hashB26, timeMs: timeB26, amount: amtB26, external: extB26,
  }), "kta");
  const emptied = await creditStaples(liveBooks, [emptyRow], { newest: "cursor-empty", ingest, now: time440 + 3000 });
  check("a missing log retries", emptied === "retry" && liveBooks.cursor === "cursor-440" && liveBooks.parked === parkedBefore);

  rpcMode = "down";
  clearCache();
  const hourNow = time440 + 10_000;
  const hourBooks = createBooks(timeB26, kta(2));
  hourBooks.cursor = "hour-old";
  const hourRow = readStaple(bridgeRow({
    blocksHash: "staple-hour", block: hashB26, timeMs: timeB26, amount: amtB26, external: extB26,
  }), "kta");
  const early = await creditStaples(hourBooks, [hourRow], { newest: "hour-new", ingest, now: hourNow });
  check("a fresh lookup failure retries", early === "retry" && hourBooks.cursor === "hour-old" && hourBooks.parked === 0n);
  const still = await creditStaples(hourBooks, [hourRow], { newest: "hour-new", ingest, now: hourNow + 3_600_000 - 1 });
  check("a lookup under an hour still retries", still === "retry" && hourBooks.cursor === "hour-old" && hourBooks.parked === 0n);
  const lines = [];
  const write = console.log;
  console.log = (...args) => {
    lines.push(args.map((item) => String(item)).join(" "));
    write(...args);
  };
  let hourResult;
  try {
    hourResult = await creditStaples(hourBooks, [hourRow], { newest: "hour-new", ingest, now: hourNow + 3_600_000 });
  } finally {
    console.log = write;
  }
  check("a lookup that fails for an hour is parked", hourResult === "ok" && hourBooks.cursor === "hour-new" && hourBooks.parked === amtB26);
  check("an hour of failures says the bridge was parked", lines.some((line) => line.includes("Bridge parked after 1h of failed lookups")
    && line.includes(hashB26) && line.includes(tB26)));
  check("a parked hour keeps the block, id, amount, and time", hourBooks.unresolved.length === 1
    && hourBooks.unresolved[0].block === hashB26
    && hourBooks.unresolved[0].t === tB26
    && hourBooks.unresolved[0].amount === amtB26.toString()
    && hourBooks.unresolved[0].time === timeB26
    && (hourBooks.share.stake.get(`base:${ORIGIN}`) ?? 0n) === 0n);
  const next = await creditStaples(hourBooks, [hourRow], { newest: "hour-next", ingest, now: hourNow + 3_600_000 + 1 });
  check("the next pass returns ok", next === "ok" && hourBooks.cursor === "hour-next" && hourBooks.parked === amtB26 && hourBooks.unresolved.length === 1);

  clearCache();
  let fetchedLate = false;
  globalThis.fetch = async () => { fetchedLate = true; throw new Error("late"); };
  let timedOut = false;
  try { await liveIo.latest(Date.now() - 1); } catch (err) { timedOut = err instanceof LookupFailed; }
  check("a lookup past the deadline does not fetch", timedOut === true && fetchedLate === false);
} finally {
  globalThis.fetch = originalFetch;
  clearCache();
}
console.log("base-credit checks", count);
