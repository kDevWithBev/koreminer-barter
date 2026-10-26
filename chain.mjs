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
// complete is true ONLY when the walk saw the cursor row, or (no cursor) a row older than stopBeforeMs (Ops B-1). An empty
// page, a short page or the end of the account's history is never proof: a truncating or lagging node looks exactly like
// that. The shaft and the fire address (the old sink) both have history from long before any pitDay1.
// chain (Ops R-1): with chain = the account's own address, the walk must also follow that account's hash chain. Every block
// the account made, newest first, must be the `previous` of the one before it, from the newest one the walk saw down to one
// in a row older than stopBeforeMs. A row missing in the middle breaks the chain, so complete stays false. head is the
// newest block hash of the account the walk saw (compare it with headAgreed).
export async function pullSince(client, account, { cursor = "", stopBeforeMs = null, pageLimit = 1_000, chain = "" } = {}) {
  const found = [];
  let start;
  const link = { head: "", expect: "", broken: "" };
  const done = (complete) => ({ rows: found, complete: complete && !link.broken, ...(chain ? { head: link.head, broken: link.broken } : {}) });
  for (let page = 0; page < pageLimit; page += 1) {
    // client is the runner's KeetaNet UserClient (run.mjs); history of ANOTHER account lives on its network Client,
    // UserClient.client.getHistory(account, { depth, startBlocksHash }). UserClient has no getHistory (box 3, Oct 26).
    // startBlocksHash is exclusive (checked on the real node, keetanet-client 0.18.7).
    const rows = await client.client.getHistory(account, { depth: 100, startBlocksHash: start });
    if (!rows?.length) return done(false);
    for (const row of rows) {
      const hash = row.voteStaple.blocksHash.toString();
      if (cursor && hash === cursor) return done(true);
      const at = row.voteStaple.timestamp?.().getTime?.();
      const old = !cursor && stopBeforeMs !== null && Number.isFinite(at) && at < stopBeforeMs;
      // In chain mode an old row only ends the walk once it holds the next link (a row the account did not author, a
      // deposit, says nothing about the chain, so keep walking past it).
      const own = chain ? chainStep(row, chain, link) : 0;
      if (link.broken) return done(false);
      if (old && (!chain || own > 0)) return done(true);
      if (!old) found.push(row);
    }
    if (rows.length < 100) return done(false);
    const next = rows[rows.length - 1].voteStaple.blocksHash.toString();
    if (next === start) return done(false);
    start = next;
  }
  return done(false);
}

// One staple of the chain walk: the account's blocks in it must form one path (each the previous of the next), its newest
// block must be the link the walk expects, and its oldest block's previous becomes the next expected link. Returns how many
// of the account's blocks the staple holds; sets link.broken on any gap. An opening block ends the chain: nothing older
// can link, so a later row of the account breaks it.
function chainStep(row, account, link) {
  const own = (row.voteStaple.blocks ?? []).filter((b) => text(b.account) === account);
  if (!own.length) return 0;
  const hashes = own.map(blockHash);
  const prevOf = (b) => (b.previous ? b.previous.toString() : "");
  const referenced = new Set(own.map(prevOf));
  const tops = own.filter((b, i) => !referenced.has(hashes[i]));
  if (tops.length !== 1 || hashes.some((h) => !h)) { link.broken = `staple ${row.voteStaple.blocksHash.toString()} has no single newest block`; return own.length; }
  let cur = tops[0];
  if (link.expect === "end") { link.broken = "a block older than the account's opening block"; return own.length; }
  if (link.expect && blockHash(cur) !== link.expect) { link.broken = `expected block ${link.expect}, got ${blockHash(cur)}: a row is missing`; return own.length; }
  if (!link.head) link.head = blockHash(cur);
  for (let n = 1; n < own.length; n += 1) {
    const p = prevOf(cur);
    const nxt = own.find((b) => blockHash(b) === p);
    if (!nxt) { link.broken = `staple ${row.voteStaple.blocksHash.toString()} blocks do not chain`; return own.length; }
    cur = nxt;
  }
  link.expect = cur.$opening ? "end" : prevOf(cur);
  if (!link.expect) link.broken = `block ${blockHash(cur)} has no previous`;
  return own.length;
}

// Ops R-1 freshness gate: every representative the client knows must report `head` as the account's head block. A lagging
// or partial rep that answered the history walk would disagree with the others, so a void then waits. No reps, an error or
// any disagreement is "not agreed". Read-only.
export async function headAgreed(client, account, head) {
  const reps = client.client.representatives ?? [];
  if (!head) return { ok: false, why: "the walk saw no block of the account" };
  if (!reps.length) return { ok: false, why: "no representatives known" };
  const got = [];
  for (const rep of reps) {
    let h = "";
    try { const info = await client.client.getAccountHeadInfo(account, rep); h = info?.block ? blockHash(info.block) : "none"; } catch { h = "error"; }
    got.push(h);
  }
  const ok = got.every((h) => h === head);
  return { ok, why: ok ? "" : `head ${head} vs reps ${got.map((h) => h.slice(0, 8)).join(" ")}`, reps: got.length };
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
// The walk follows the shaft's own hash chain (Ops R-1), so a missing middle row is never complete; head is its newest block.
export async function findKeyedSends(client, account, { sinceMs, koreText, pageLimit = 1_000 }) {
  const got = await pullSince(client, account, { stopBeforeMs: sinceMs, pageLimit, chain: account });
  const sends = [];
  for (const row of got.rows) sends.push(...readKeyedSends(row, { from: account, koreText }));
  return { complete: got.complete, sends, head: got.head, broken: got.broken };
}
