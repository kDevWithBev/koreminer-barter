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
        deposits.push({ from, amount });
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
