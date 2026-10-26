// readFireStaple / pullSince (chain.mjs). Offline.
import { pullSince, readFireStaple } from "./chain.mjs";

const FIRE = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const INTAKE = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const KORE = "keeta_apu6efya45r6rirjwyhl25djcuqg53zlepwctj7xpzvmrhfwckrzxwht4sypk";
const USDC = "keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna";
const BASE = "keeta_base_token_stand_in";
function check(name, ok) { if (!ok) throw new Error(name); console.log("ok", name); }
const acct = (s) => ({ publicKeyString: { toString: () => s } });
const row = (hash, iso, blocks) => ({ voteStaple: { blocksHash: { toString: () => hash }, timestamp: () => new Date(iso), blocks } });

const r = row("S1", "2026-11-02T01:00:00.000Z", [
  { account: acct("keeta_w1"), hash: "B1", operations: [{ type: 0, to: acct(FIRE), token: acct(BASE), amount: 3n * 10n ** 18n }] },
  { account: acct("keeta_aabz6zxb"), hash: "B2", operations: [
    { type: 7, to: acct(FIRE) },
    { type: 0, to: acct(FIRE), token: acct(KORE), amount: 1n },
    { type: 0, to: acct(FIRE), token: acct(USDC), amount: 10_000n },
    { type: 0, to: acct(INTAKE), token: acct(BASE), amount: 5n },
  ] },
]);
const st = readFireStaple(r, { fire: FIRE, baseText: BASE, koreText: KORE });
check("every send op to fire is a row, other ops and other addresses are not", st.sends.length === 3);
check("KTA ticket keeps its own (block, op)", st.sends[0].block === "B1" && st.sends[0].op === 0 && st.sends[0].token === "KTA");
check("KORE and USDC in one block get op 1 and op 2 (index in the block)", st.sends[1].op === 1 && st.sends[1].token === "KORE" && st.sends[2].op === 2 && st.sends[2].token === USDC);
check("same staple, same time", new Set(st.sends.map((s) => s.time)).size === 1 && st.sends[0].time === "2026-11-02T01:00:00.000Z");
check("amounts are BigInt", st.sends.every((s) => typeof s.amount === "bigint"));
const nohash = readFireStaple(row("S2", "2026-11-02T02:00:00.000Z", [{ account: acct("keeta_w2"), operations: [{ type: 0, to: acct(FIRE), token: acct(BASE), amount: 1n }] }]), { fire: FIRE, baseText: BASE, koreText: KORE });
check("a block without a hash falls back to staple#index", nohash.sends[0].block === "S2#0");

const rows = Array.from({ length: 250 }, (_, i) => row(`H${i}`, new Date(Date.parse("2026-11-03T00:00:00Z") - i * 60_000).toISOString(), []));
const client = { getHistory: async (acc, { startBlocksHash }) => {
  if (acc !== FIRE) throw new Error("wrong account");
  const i = startBlocksHash ? rows.findIndex((x) => x.voteStaple.blocksHash.toString() === startBlocksHash) + 1 : 0;
  return rows.slice(i, i + 100);
} };
const a = await pullSince(client, FIRE, { cursor: "H120" });
check("walks pages back to the cursor, newest first", a.complete && a.rows.length === 120 && a.rows[0].voteStaple.blocksHash.toString() === "H0");
const b = await pullSince(client, FIRE, { stopBeforeMs: Date.parse("2026-11-02T23:00:00Z") });
check("no cursor: stops at the start time", b.complete && b.rows.length === 61);
const c = await pullSince(client, FIRE, { cursor: "missing" });
check("a cursor that is never found is incomplete", c.complete === false);
console.log("chain fire ok");
