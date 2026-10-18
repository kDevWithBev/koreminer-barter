// Name a new bridge delivery. Does not publish a block.
import { inflateSync } from "node:zlib";
import { BRIDGE, isKeetaAddress } from "./claim.mjs";

export const SHAFT = "0xfe6d5e3f8cff2dc8d2dea137c87f721c69343d7d";
export const BRIDGE_CONTRACT = "0x1c24a0fb7bcf2154a9d37b7b3aa443bc63fcc698";
export const KTA = "0xc0634090f2fe6c6d75e61be2b949464abb498973";
export const ENTRYPOINT = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
export const INTAKE = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const META = "keeta_aabuj72zbrxawqq7pibfbvebquvmar5ltgcol24rs7cq2cad7q7mepmgcxifufq";
const DEPOSIT_TOPIC = "0x4799b8d532da22980c5d2274e923177e9d9676df4fd980af8bb5f854a2c4b9c6";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ROUTER_CODE = 1000;
const BEFORE = 720n;
const AFTER = 120n;
const CHUNK = 400n;
const FAIL_MS = 3_600_000;
const FETCH_MS = 10_000;
const LOOP_MS = 20_000;
const BANNED = new Set([SHAFT, BRIDGE_CONTRACT, ENTRYPOINT]);
const RPCS = ["https://base.gateway.tenderly.co", "https://base-rpc.publicnode.com", "https://base.drpc.org"];

export class LookupFailed extends Error {
  constructor() { super("Base lookup failed, retry"); }
}

export function isBaseAddress(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
}

export function keetaBytes(address) {
  const body = String(address || "").startsWith("keeta_") ? String(address).slice(6) : "";
  if (!body || /[^a-z2-7]/i.test(body)) return Buffer.alloc(0);
  let bits = "";
  for (const char of body.toUpperCase()) bits += B32.indexOf(char).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function shaftDestination() {
  return keetaBytes(INTAKE).subarray(0, 34).toString("hex");
}

export function decodeDepositId(external) {
  const text = typeof external === "string" ? external.trim() : "";
  if (/^0x[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
  if (!text) return "";
  let bytes;
  try { bytes = Buffer.from(text, "base64"); } catch { return ""; }
  if (bytes.length === 0) return "";
  let at = -1;
  for (let i = 0; i < bytes.length - 1; i += 1) {
    if (bytes[i] === 0x78 && bytes[i + 1] === 0x9c) { at = i; break; }
  }
  if (at < 0) return "";
  let json;
  try { json = JSON.parse(inflateSync(bytes.subarray(at)).toString("utf8")); } catch { return ""; }
  const raw = json?.a?.[META]?.t;
  if (raw == null || !/^\d+$/.test(String(raw))) return "";
  return `0x${BigInt(raw).toString(16).padStart(64, "0")}`;
}

export function chooseSender({ transferFrom, txFrom, txTo, codeSize }) {
  const from = String(transferFrom || "").toLowerCase();
  const origin = String(txFrom || "").toLowerCase();
  const to = String(txTo || "").toLowerCase();
  if (!isBaseAddress(from)) return "";
  const sizeOf = typeof codeSize === "function" ? codeSize : () => 0;
  const fromCode = Number(sizeOf(from) || 0);
  let credit = from;
  if (fromCode > ROUTER_CODE && to !== ENTRYPOINT) credit = origin;
  if (!isBaseAddress(credit) || BANNED.has(credit)) return "";
  const creditCode = credit === from ? fromCode : Number(sizeOf(credit) || 0);
  if (creditCode > ROUTER_CODE) return "";
  return credit;
}

function asBig(value) {
  try { return BigInt(value); } catch { return -1n; }
}

export function pickTransfer(logs, tx) {
  const hash = String(tx?.hash || "").toLowerCase();
  const block = asBig(tx?.blockNumber);
  const index = asBig(tx?.transactionIndex);
  let same = null;
  let sameAt = -1n;
  let prior = null;
  let priorAt = null;
  for (const log of logs ?? []) {
    if (String(log.to || "").toLowerCase() !== SHAFT) continue;
    const logBlock = asBig(log.blockNumber ?? tx.blockNumber);
    const logIndex = asBig(log.logIndex);
    const txIndex = asBig(log.transactionIndex);
    if (String(log.transactionHash || "").toLowerCase() === hash) {
      if (logIndex >= sameAt) { same = log; sameAt = logIndex; }
      continue;
    }
    if (!(logBlock < block || (logBlock === block && txIndex < index))) continue;
    const at = logBlock * 10n ** 12n + txIndex * 10n ** 6n + (logIndex < 0n ? 0n : logIndex);
    if (priorAt === null || at > priorAt) { prior = log; priorAt = at; }
  }
  return same || prior || null;
}

const txMemo = new Map();
const logMemo = new Map();
const codeMemo = new Map();
const resultMemo = new Map();

export function clearCache() {
  txMemo.clear();
  logMemo.clear();
  codeMemo.clear();
  resultMemo.clear();
}

function topicAddress(topic) {
  if (typeof topic !== "string" || topic.length < 42) return "";
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function word(data, index) {
  const hex = String(data || "").startsWith("0x") ? String(data).slice(2) : String(data || "");
  return hex.slice(index * 64, (index + 1) * 64);
}

async function rpc(method, params, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) throw new LookupFailed();
  const urls = process.env.BASE_RPC ? [process.env.BASE_RPC, ...RPCS] : RPCS;
  for (const url of urls) {
    const leftNow = deadline - Date.now();
    if (leftNow <= 0) throw new LookupFailed();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "koreminer/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(Math.min(FETCH_MS, leftNow)),
      });
      const body = await response.json();
      if (body && body.error == null && body.result !== undefined && body.result !== null) return body.result;
    } catch (err) {
      if (err instanceof LookupFailed) throw err;
    }
  }
  throw new LookupFailed();
}

export const liveIo = {
  async latest(deadline) {
    const block = await rpc("eth_getBlockByNumber", ["latest", false], deadline);
    if (!block?.number || block.timestamp == null) throw new LookupFailed();
    return { number: BigInt(block.number), time: Number(BigInt(block.timestamp)) };
  },
  async deposits(fromBlock, toBlock, deadline) {
    const key = `${fromBlock}:${toBlock}`;
    if (logMemo.has(key)) return logMemo.get(key);
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += CHUNK) {
      const end = start + CHUNK - 1n > toBlock ? toBlock : start + CHUNK - 1n;
      const raw = await rpc("eth_getLogs", [{
        fromBlock: `0x${start.toString(16)}`,
        toBlock: `0x${end.toString(16)}`,
        address: BRIDGE_CONTRACT,
        topics: [DEPOSIT_TOPIC, null, null, `0x${KTA.slice(2).padStart(64, "0")}`],
      }], deadline);
      if (!Array.isArray(raw)) throw new LookupFailed();
      for (const log of raw) {
        const amountWord = word(log.data, 2);
        const lenWord = word(log.data, 3);
        if (!amountWord || !lenWord) continue;
        const len = Number(BigInt(`0x${lenWord}`));
        const hex = String(log.data).slice(2);
        logs.push({
          id: `0x${word(log.data, 0)}`,
          sender: topicAddress(log.topics?.[2]),
          amount: BigInt(`0x${amountWord}`),
          recipient: hex.slice(256, 256 + len * 2).toLowerCase(),
          transactionHash: String(log.transactionHash || "").toLowerCase(),
          blockNumber: log.blockNumber,
          transactionIndex: log.transactionIndex,
          logIndex: log.logIndex,
        });
      }
    }
    if (logs.length > 0) logMemo.set(key, logs);
    return logs;
  },
  async tx(hash, deadline) {
    const key = String(hash || "").toLowerCase();
    if (txMemo.has(key)) return txMemo.get(key);
    const tx = await rpc("eth_getTransactionByHash", [key], deadline);
    if (!tx?.blockNumber) throw new LookupFailed();
    const shaped = {
      hash: key,
      from: String(tx.from || "").toLowerCase(),
      to: String(tx.to || "").toLowerCase(),
      blockNumber: tx.blockNumber,
      transactionIndex: tx.transactionIndex,
    };
    txMemo.set(key, shaped);
    return shaped;
  },
  async transfers(fromBlock, toBlock, deadline) {
    const key = `kta:${fromBlock}:${toBlock}`;
    if (logMemo.has(key)) return logMemo.get(key);
    const raw = await rpc("eth_getLogs", [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      address: KTA,
      topics: [TRANSFER, null, `0x${SHAFT.slice(2).padStart(64, "0")}`],
    }], deadline);
    if (!Array.isArray(raw)) throw new LookupFailed();
    const logs = raw.map((log) => ({
      transactionHash: String(log.transactionHash || "").toLowerCase(),
      blockNumber: log.blockNumber,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      from: topicAddress(log.topics?.[1]),
      to: topicAddress(log.topics?.[2]),
      amount: BigInt(log.data),
    }));
    if (logs.length > 0) logMemo.set(key, logs);
    return logs;
  },
  async code(addr, deadline) {
    const key = String(addr || "").toLowerCase();
    if (codeMemo.has(key)) return codeMemo.get(key);
    const code = await rpc("eth_getCode", [key, "latest"], deadline);
    const size = !code || code === "0x" ? 0 : (String(code).length - 2) / 2;
    codeMemo.set(key, size);
    return size;
  },
};

function transferKey(log) {
  return `${String(log.transactionHash).toLowerCase()}:${String(log.logIndex).toLowerCase()}`;
}

export async function resolveTx(txHash, io = liveIo, deadline = Date.now() + FETCH_MS) {
  const key = String(txHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) return "";
  if (resultMemo.has(key)) return resultMemo.get(key);
  const tx = await io.tx(key, deadline);
  if (!tx?.blockNumber) throw new LookupFailed();
  const block = BigInt(tx.blockNumber);
  const logs = await io.transfers(block > 20n ? block - 20n : 0n, block, deadline);
  const transfer = pickTransfer(logs, { ...tx, hash: key });
  if (!transfer) {
    resultMemo.set(key, "");
    return "";
  }
  const swapHash = String(transfer.transactionHash || key).toLowerCase();
  const swap = swapHash === key ? tx : await io.tx(swapHash, deadline);
  if (!swap) throw new LookupFailed();
  const sizes = new Map();
  const read = async (addr) => {
    const lowered = String(addr || "").toLowerCase();
    if (!isBaseAddress(lowered)) return 0;
    if (!sizes.has(lowered)) sizes.set(lowered, Number(await io.code(lowered, deadline) || 0));
    return sizes.get(lowered);
  };
  await read(transfer.from);
  await read(swap.from);
  const sender = chooseSender({
    transferFrom: transfer.from,
    txFrom: swap.from,
    txTo: swap.to,
    codeSize: (addr) => sizes.get(String(addr).toLowerCase()) || 0,
  });
  resultMemo.set(key, sender || "");
  return sender || "";
}

async function findCredit(t, amount, timeMs, { io, used, deadline }) {
  const latest = await io.latest(deadline);
  if (!latest?.number || latest.time == null) throw new LookupFailed();
  const head = BigInt(latest.number);
  const age = BigInt(Math.max(0, Math.floor(Number(latest.time)) - Math.floor(Number(timeMs) / 1000)));
  const est = head > age / 2n ? head - age / 2n : 0n;
  const slop = age / 6n;
  const before = BEFORE + slop;
  const after = AFTER + slop;
  const from = est > before ? est - before : 0n;
  const to = est + after > head ? head : est + after;
  const deposits = await io.deposits(from, to, deadline);
  if (!Array.isArray(deposits)) throw new LookupFailed();
  const dest = shaftDestination();
  const withId = deposits.filter((log) => log && String(log.id).toLowerCase() === t);
  if (withId.length === 0) throw new LookupFailed();
  const sweeps = withId.filter((log) => String(log.sender).toLowerCase() === SHAFT
    && String(log.recipient).toLowerCase() === dest
    && log.amount === amount);
  if (sweeps.length !== 1) return null;
  const sweep = await io.tx(sweeps[0].transactionHash, deadline);
  if (!sweep?.blockNumber) throw new LookupFailed();
  const block = BigInt(sweep.blockNumber);
  const logs = await io.transfers(block > 20n ? block - 20n : 0n, block, deadline);
  if (!Array.isArray(logs)) throw new LookupFailed();
  const matched = logs.filter((log) => String(log.to).toLowerCase() === SHAFT && log.amount === amount);
  const unused = matched.filter((log) => !used.has(transferKey(log)));
  const transfer = unused.length === 1 ? pickTransfer(unused, { ...sweep, hash: sweep.hash }) : null;
  if (!transfer || transfer.amount !== amount) return null;
  const swapHash = String(transfer.transactionHash).toLowerCase();
  const swap = swapHash === sweep.hash ? sweep : await io.tx(swapHash, deadline);
  if (!swap?.blockNumber) throw new LookupFailed();
  const sizes = new Map();
  const read = async (addr) => {
    const lowered = String(addr || "").toLowerCase();
    if (!isBaseAddress(lowered)) return 0;
    if (!sizes.has(lowered)) sizes.set(lowered, Number(await io.code(lowered, deadline) || 0));
    return sizes.get(lowered);
  };
  await read(transfer.from);
  await read(swap.from);
  const sender = chooseSender({
    transferFrom: transfer.from,
    txFrom: swap.from,
    txTo: swap.to,
    codeSize: (addr) => sizes.get(String(addr).toLowerCase()) || 0,
  });
  if (!sender) return null;
  return { sender, transfer: transferKey(transfer) };
}

function rememberFailure(books, t, now) {
  books.lookupSince ??= {};
  if (!books.lookupSince[t]) books.lookupSince[t] = now;
  return now - Number(books.lookupSince[t]) >= FAIL_MS;
}

export async function attributeDeposits(staple, { links = {}, books = {}, io = liveIo, now = Date.now(), deadline } = {}) {
  const limit = deadline ?? now + LOOP_MS;
  const used = new Set(books.used ?? []);
  const deposits = [];
  for (const item of staple?.deposits ?? []) {
    if (item.from !== BRIDGE) {
      deposits.push(item);
      continue;
    }
    const t = decodeDepositId(item.external);
    const block = String(item.block || staple.blocksHash || "");
    const parked = { ...item, credit: false, t, block };
    if (!t) {
      console.log("Bridge unresolved.", block || "none", "none");
      deposits.push(parked);
      continue;
    }
    try {
      const found = await findCredit(t, item.amount, staple.timeMs, { io, used, deadline: limit });
      if (books.lookupSince) delete books.lookupSince[t];
      if (!found) {
        console.log("Bridge unresolved.", block || "none", t);
        deposits.push(parked);
        continue;
      }
      used.add(found.transfer);
      const linked = links?.[found.sender]?.keeta;
      const from = isKeetaAddress(linked) && linked !== BRIDGE ? linked : `base:${found.sender}`;
      deposits.push({ ...item, from, t, block, transfer: found.transfer });
    } catch {
      if (rememberFailure(books, t, now)) {
        delete books.lookupSince[t];
        console.log("Bridge parked after 1h of failed lookups", block || "none", t);
        deposits.push(parked);
        continue;
      }
      return { retry: true, staple };
    }
  }
  return { retry: false, staple: { ...staple, deposits } };
}

export async function creditStaples(books, staples, options) {
  const deadline = Date.now() + LOOP_MS;
  for (const staple of staples ?? []) {
    if (staple?.blocksHash && books.recent?.includes(staple.blocksHash)) continue;
    const named = await attributeDeposits(staple, { ...options, books, deadline });
    if (named.retry) {
      console.log("Base lookup failed, retry");
      return "retry";
    }
    if (options.ingest(books, named.staple) === "halt-reserve") return "halt-reserve";
  }
  if (options.newest) books.cursor = options.newest;
  return "ok";
}
