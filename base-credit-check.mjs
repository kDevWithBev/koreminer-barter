import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attributeDeposits, chooseSender, clearCache, ENTRYPOINT, resolveTx, SHAFT } from "./base-credit.mjs";
import { accounted, booksFromJson, booksToJson, createBooks, ingest, publicBooks } from "./books.mjs";
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

check("pay.mjs was not edited", fileHash("./pay.mjs") === "cf5ca7e0581bcf10deaa40844defabf2");
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

const lump = createBooks(open, kta(2));
deposit(lump.share, BRIDGE, kta(23), open);
const before = lump.share.stake.get(BRIDGE);
const unresolved = await attributeDeposits({
  blocksHash: "missing",
  timeMs: open + 1000,
  deposits: [{ from: BRIDGE, amount: kta(11) }, { from: "keeta_alice", amount: kta(4), external: "" }],
}, { links: {}, resolve: async () => WALLET });
check("a delivery with no base tx is unresolved", unresolved.deposits[0].credit === false && unresolved.deposits[0].tx === "none");
check("a native deposit is left alone", unresolved.deposits[1].from === "keeta_alice");
ingest(lump, unresolved);
check("unresolved fuel is not credited to the bridge", lump.share.stake.get(BRIDGE) === before);
check("unresolved fuel is not credited to a wallet", ![...lump.share.stake.keys()].some((key) => key.startsWith("base:")));
check("the unresolved tx is recorded", lump.unresolved.length === 1 && lump.unresolved[0].tx === "none" && lump.parked === kta(11));
check("the books still balance with nobody credited", accounted(lump) === kta(2) + kta(23) + kta(11) + kta(4));

const named = await attributeDeposits({
  blocksHash: "named",
  timeMs: open + 2000,
  deposits: [{ from: BRIDGE, amount: kta(11), external: TX1 }],
}, { links: {}, resolve: async () => WALLET });
ingest(lump, named);
check("a new delivery does not add to the old bridge lump", lump.share.stake.get(BRIDGE) === before);
check("the new delivery is held under the real base address", lump.share.stake.get(`base:${WALLET}`) === kta(11));
const view = publicBooks(lump);
check("the old held entry stays labeled with the shaft address", view.held.some((row) => row.base === SHAFT));
check("the new held entry uses the real sender", view.held.some((row) => row.base === WALLET));
check("a base key is not on the miner board", view.board.every((row) => !row.from.startsWith("base:") && row.from !== BRIDGE));

const linkedKeeta = keeta1;
const linked = await attributeDeposits({
  blocksHash: "linked",
  timeMs: open + 3000,
  deposits: [{ from: BRIDGE, amount: kta(3), external: TX2 }],
}, { links: { [ORIGIN]: { keeta: linkedKeeta } }, resolve: async () => ORIGIN });
ingest(lump, linked);
check("a linked sender is credited to that keeta address", lump.share.stake.get(linkedKeeta) === kta(3));
check("a linked sender is not also stored as base", (lump.share.stake.get(`base:${ORIGIN}`) ?? 0n) === 0n);

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
console.log("base-credit checks", count);
