// Name a new bridge delivery. Does not read or write the books.
import { BRIDGE, isKeetaAddress } from "./claim.mjs";

export const SHAFT = "0xfe6d5e3f8cff2dc8d2dea137c87f721c69343d7d";
export const BRIDGE_CONTRACT = "0x1c24a0fb7bcf2154a9d37b7b3aa443bc63fcc698";
export const KTA = "0xc0634090f2fe6c6d75e61be2b949464abb498973";
export const ENTRYPOINT = "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ROUTER_CODE = 1000;
const BANNED = new Set([SHAFT, BRIDGE_CONTRACT, ENTRYPOINT]);
const RPCS = ["https://base-rpc.publicnode.com", "https://base.drpc.org"];

export function isBaseAddress(value) {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
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

const cache = new Map();
const txMemo = new Map();
const logMemo = new Map();
const codeMemo = new Map();

export function clearCache() {
  cache.clear();
  txMemo.clear();
  logMemo.clear();
  codeMemo.clear();
}

function topicAddress(topic) {
  if (typeof topic !== "string" || topic.length < 42) return "";
  return `0x${topic.slice(-40).toLowerCase()}`;
}

async function rpc(method, params) {
  const urls = process.env.BASE_RPC ? [process.env.BASE_RPC, ...RPCS] : RPCS;
  let reason = "rpc";
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "koreminer/1.0" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await response.json();
      if (body && body.error == null && body.result !== undefined) return body.result;
      reason = "rpc";
    } catch {
      reason = "rpc";
    }
  }
  throw new Error(reason);
}

export const liveIo = {
  async tx(hash) {
    const key = String(hash || "").toLowerCase();
    if (txMemo.has(key)) return txMemo.get(key);
    const tx = await rpc("eth_getTransactionByHash", [key]);
    const shaped = tx && tx.blockNumber ? {
      hash: key,
      from: String(tx.from || "").toLowerCase(),
      to: String(tx.to || "").toLowerCase(),
      blockNumber: tx.blockNumber,
      transactionIndex: tx.transactionIndex,
    } : null;
    txMemo.set(key, shaped);
    return shaped;
  },
  async transfers(fromBlock, toBlock) {
    const key = `${fromBlock}:${toBlock}`;
    if (logMemo.has(key)) return logMemo.get(key);
    const raw = await rpc("eth_getLogs", [{
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      address: KTA,
      topics: [TRANSFER, null, `0x${SHAFT.slice(2).padStart(64, "0")}`],
    }]);
    const logs = (Array.isArray(raw) ? raw : []).map((log) => ({
      transactionHash: String(log.transactionHash || "").toLowerCase(),
      blockNumber: log.blockNumber,
      transactionIndex: log.transactionIndex,
      logIndex: log.logIndex,
      from: topicAddress(log.topics?.[1]),
      to: topicAddress(log.topics?.[2]),
    }));
    logMemo.set(key, logs);
    return logs;
  },
  async code(addr) {
    const key = String(addr || "").toLowerCase();
    if (codeMemo.has(key)) return codeMemo.get(key);
    const code = await rpc("eth_getCode", [key, "latest"]);
    const size = !code || code === "0x" ? 0 : (String(code).length - 2) / 2;
    codeMemo.set(key, size);
    return size;
  },
};

export async function resolveTx(txHash, io = liveIo) {
  const key = String(txHash || "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) return "";
  if (cache.has(key)) return cache.get(key);
  let sender = "";
  try {
    const tx = await io.tx(key);
    if (tx?.blockNumber) {
      const block = BigInt(tx.blockNumber);
      const logs = await io.transfers(block > 20n ? block - 20n : 0n, block);
      const transfer = pickTransfer(logs, { ...tx, hash: key });
      if (transfer) {
        const swapHash = String(transfer.transactionHash || key).toLowerCase();
        const swap = swapHash === key ? tx : await io.tx(swapHash);
        if (swap) {
          const sizes = new Map();
          const read = async (addr) => {
            const lowered = String(addr || "").toLowerCase();
            if (!isBaseAddress(lowered)) return 0;
            if (!sizes.has(lowered)) sizes.set(lowered, Number(await io.code(lowered) || 0));
            return sizes.get(lowered);
          };
          await read(transfer.from);
          await read(swap.from);
          sender = chooseSender({
            transferFrom: transfer.from,
            txFrom: swap.from,
            txTo: swap.to,
            codeSize: (addr) => sizes.get(String(addr).toLowerCase()) || 0,
          });
        }
      }
    }
  } catch {
    sender = "";
  }
  cache.set(key, sender || "");
  return sender || "";
}

export async function attributeDeposits(staple, { links = {}, resolve } = {}) {
  const deposits = [];
  for (const item of staple?.deposits ?? []) {
    if (item.from !== BRIDGE) {
      deposits.push(item);
      continue;
    }
    const tx = typeof item.external === "string" ? item.external.toLowerCase() : "";
    const known = /^0x[0-9a-f]{64}$/.test(tx);
    let sender = "";
    if (known) {
      try {
        const found = typeof resolve === "function" ? await resolve(tx) : await resolveTx(tx);
        sender = String(found || "").toLowerCase();
      } catch {
        sender = "";
      }
    }
    if (!isBaseAddress(sender) || BANNED.has(sender)) {
      console.log("Bridge unresolved.", known ? tx : "none");
      deposits.push({ ...item, credit: false, tx: known ? tx : "none" });
      continue;
    }
    const linked = links?.[sender]?.keeta;
    const from = isKeetaAddress(linked) && linked !== BRIDGE ? linked : `base:${sender}`;
    deposits.push({ ...item, from });
  }
  return { ...staple, deposits };
}
