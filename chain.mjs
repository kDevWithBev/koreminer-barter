// Read one history row into a plain staple. No network calls.

const intake =
  "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const sink =
  "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";

function text(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toString === "function" && value.publicKeyString) return value.publicKeyString.toString();
  return value.publicKeyString?.toString?.() ?? "";
}

function rawExternal(value) {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return "";
}

function blockHash(block) {
  const value = block?.hash ?? block?.$hash;
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value.toString === "function") {
    const text = value.toString();
    if (text && text !== "[object Object]") return text;
  }
  return "";
}

export function readStaple(row, base) {
  const staple = row?.voteStaple;
  if (!staple?.timestamp || !staple?.blocksHash) return null;
  const timeMs = staple.timestamp().getTime();
  if (!Number.isFinite(timeMs)) return null;
  const deposits = [];
  let ownPicks = 0;
  for (const block of staple.blocks ?? []) {
    const from = text(block.account);
    let own = false;
    for (const op of block.operations ?? []) {
      if (op.type !== 0) continue;
      const to = text(op.to);
      const token = text(op.token);
      let amount = 0n;
      try { amount = BigInt(op.amount); } catch { amount = 0n; }
      if (from === intake && to === sink && token === base) own = true;
      if (to === intake && token === base && from !== intake && from !== sink && amount > 0n) {
        deposits.push({
          from,
          amount,
          external: rawExternal(op.external) || rawExternal(block.external),
          block: blockHash(block),
        });
      }
    }
    if (own) ownPicks += 1;
  }
  return {
    blocksHash: staple.blocksHash.toString(),
    timeMs,
    deposits,
    ownPicks,
  };
}

export async function pullNew(client, cursor) {
  const found = [];
  let start;
  while (found.length < 5_000) {
    const query = { depth: 100, startBlocksHash: start };
    const rows = typeof client.getHistory === "function"
      ? await client.getHistory(intake, query)
      : await client.history(query);
    if (!rows?.length) break;
    let hit = false;
    for (const row of rows) {
      const hash = row.voteStaple.blocksHash.toString();
      if (cursor && hash === cursor) {
        hit = true;
        break;
      }
      found.push(row);
    }
    if (hit || rows.length < 100) break;
    const next = rows[rows.length - 1].voteStaple.blocksHash.toString();
    if (next === start) break;
    start = next;
  }
  return found;
}

// ---- pit (new model): every op sent to the fire address, one row per (block, op) ----
// KTA rows can count for mining; KORE and any other token are logged as burns by pit.mjs. No network calls.
export function readFireStaple(row, { fire = sink, baseText, koreText }) {
  const staple = row?.voteStaple;
  if (!staple?.timestamp || !staple?.blocksHash) return null;
  const timeMs = staple.timestamp().getTime();
  if (!Number.isFinite(timeMs)) return null;
  const time = new Date(timeMs).toISOString();
  const stapleHash = staple.blocksHash.toString();
  const sends = [];
  (staple.blocks ?? []).forEach((block, blockIndex) => {
    const from = text(block.account);
    const hash = blockHash(block) || `${stapleHash}#${blockIndex}`;
    (block.operations ?? []).forEach((op, opIndex) => {
      if (op.type !== 0) return;
      const to = text(op.to);
      if (to !== fire) return;
      const tokenText = text(op.token);
      const token = tokenText === baseText ? "KTA" : tokenText === koreText ? "KORE" : tokenText || "unknown";
      let amount = 0n;
      try { amount = BigInt(op.amount); } catch { amount = 0n; }
      sends.push({ tx: hash, block: hash, op: opIndex, staple: stapleHash, from, to, token, amount, time, timeMs });
    });
  });
  return { blocksHash: stapleHash, timeMs, sends };
}

// Newest-first history of `account` back to `cursor` (exclusive), or back past stopBeforeMs when there is no cursor yet.
// complete is false when the walk ended without reaching either; the caller must not advance its cursor then.
export async function pullSince(client, account, { cursor = "", stopBeforeMs = null, pageLimit = 1_000 } = {}) {
  const found = [];
  let start;
  for (let page = 0; page < pageLimit; page += 1) {
    const rows = await client.getHistory(account, { depth: 100, startBlocksHash: start });
    if (!rows?.length) return { rows: found, complete: true };
    for (const row of rows) {
      const hash = row.voteStaple.blocksHash.toString();
      if (cursor && hash === cursor) return { rows: found, complete: true };
      const at = row.voteStaple.timestamp?.().getTime?.();
      if (!cursor && stopBeforeMs !== null && Number.isFinite(at) && at < stopBeforeMs) return { rows: found, complete: true };
      found.push(row);
    }
    if (rows.length < 100) return { rows: found, complete: !cursor };
    const next = rows[rows.length - 1].voteStaple.blocksHash.toString();
    if (next === start) return { rows: found, complete: false };
    start = next;
  }
  return { rows: found, complete: false };
}

// ---- pit payouts (Ops R-B1): KORE sends made BY `from` (the shaft), with their external key. No network calls. ----
// The external is kept in every form it may come back in (string, or bytes as utf8 and base64) so a key match never
// depends on how the node returns it.
function externalForms(value) {
  if (typeof value === "string") return value ? [value] : [];
  if (value instanceof Uint8Array) {
    const b = Buffer.from(value);
    return [b.toString("utf8"), b.toString("base64")];
  }
  return [];
}
export function readKeyedSends(row, { from, koreText }) {
  const staple = row?.voteStaple;
  if (!staple?.timestamp || !staple?.blocksHash) return [];
  const timeMs = staple.timestamp().getTime();
  const out = [];
  (staple.blocks ?? []).forEach((block, blockIndex) => {
    if (text(block.account) !== from) return;
    const hash = blockHash(block) || `${staple.blocksHash.toString()}#${blockIndex}`;
    (block.operations ?? []).forEach((op, opIndex) => {
      if (op.type !== 0 || text(op.token) !== koreText) return;
      let amount = 0n;
      try { amount = BigInt(op.amount); } catch { amount = 0n; }
      out.push({ externals: [...externalForms(op.external), ...externalForms(block.external)], to: text(op.to), amount, block: hash, op: opIndex, timeMs });
    });
  });
  return out;
}
// Every KORE send the shaft made back to sinceMs. complete is false when the walk could not reach sinceMs.
export async function findKeyedSends(client, account, { sinceMs, koreText, pageLimit = 1_000 }) {
  const got = await pullSince(client, account, { stopBeforeMs: sinceMs, pageLimit });
  const sends = [];
  for (const row of got.rows) sends.push(...readKeyedSends(row, { from: account, koreText }));
  return { complete: got.complete, sends };
}
