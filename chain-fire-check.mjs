// readFireStaple / pullSince (chain.mjs). Offline.
import { findKeyedSends, headAgreed, pullSince, readFireStaple, readKeyedSends } from "./chain.mjs";

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
const client = { client: { getHistory: async (acc, { startBlocksHash }) => {
  if (acc !== FIRE) throw new Error("wrong account");
  const i = startBlocksHash ? rows.findIndex((x) => x.voteStaple.blocksHash.toString() === startBlocksHash) + 1 : 0;
  return rows.slice(i, i + 100);
} } };
const a = await pullSince(client, FIRE, { cursor: "H120" });
check("walks pages back to the cursor, newest first", a.complete && a.rows.length === 120 && a.rows[0].voteStaple.blocksHash.toString() === "H0");
const b = await pullSince(client, FIRE, { stopBeforeMs: Date.parse("2026-11-02T23:00:00Z") });
check("no cursor: stops at the start time", b.complete && b.rows.length === 61);
const c = await pullSince(client, FIRE, { cursor: "missing" });
check("a cursor that is never found is incomplete", c.complete === false);
// Ops B-1: complete only after a row older than the start (or the cursor) was seen; an empty or short page is not proof.
const fake = (pages) => ({ client: { getHistory: async (acc, { startBlocksHash }) => { const i = startBlocksHash ? rows.findIndex((x) => x.voteStaple.blocksHash.toString() === startBlocksHash) + 1 : 0; return pages(i); } } });
const e1 = await pullSince(fake(() => []), FIRE, { stopBeforeMs: Date.parse("2026-11-02T23:00:00Z") });
check("B-1 empty first page, no cursor: incomplete", e1.complete === false);
const e2 = await pullSince(fake(() => []), FIRE, { cursor: "H5" });
check("B-1 empty first page with a cursor: incomplete", e2.complete === false);
const e3 = await pullSince(fake((i) => rows.slice(i, Math.min(i + 100, 30))), FIRE, { stopBeforeMs: Date.parse("2026-11-02T23:00:00Z") });
check("B-1 short page that never reaches the start time: incomplete", e3.complete === false && e3.rows.length === 30);
const e4 = await pullSince(fake((i) => rows.slice(i, i + 100).slice(0, 70)), FIRE, { stopBeforeMs: Date.parse("2026-11-02T23:00:00Z") });
check("B-1 short page that does reach the start time: complete", e4.complete === true && e4.rows.length === 61);
const e5 = await pullSince(fake((i) => rows.slice(i, i + 100)), FIRE, { stopBeforeMs: Date.parse("2020-01-01T00:00:00Z") });
check("B-1 the whole history ends before the start time is reached: incomplete", e5.complete === false && e5.rows.length === 250);
// Ops O14: only KORE sends made BY the shaft are its keyed sends.
const SH = "keeta_shaft_stand_in";
const kr = row("K1", "2026-11-02T01:00:00.000Z", [
  { account: acct(SH), hash: "KB1", operations: [{ type: 0, to: acct("keeta_w1"), token: acct(KORE), amount: 5n, external: "kore-keeta_w1-5" }, { type: 0, to: acct("keeta_w1"), token: acct(BASE), amount: 5n, external: "kore-keeta_w1-5" }] },
  { account: acct("keeta_other"), hash: "KB2", operations: [{ type: 0, to: acct("keeta_w1"), token: acct(KORE), amount: 5n, external: "kore-keeta_w1-5" }] },
]);
const ks = readKeyedSends(kr, { from: SH, koreText: KORE });
check("O14 a keyed KORE send from another account, or a non-KORE op from the shaft, is not a shaft payout", ks.length === 1 && ks[0].block === "KB1" && ks[0].op === 0 && ks[0].externals[0] === "kore-keeta_w1-5");
// Ops R-1: the shaft's hash chain. Real mainnet shape (Oct 26): each payout staple holds a fee block then the payout
// block, both by the shaft; block 1's previous is block 0, block 0's previous is block 1 of the staple below.
const hx = (h) => ({ toString: () => h });
const pay = (n, iso, opts = {}) => row(`T${n}`, iso, [
  { account: acct(SH), hash: hx(`F${n}`), previous: hx(`P${n - 1}`), ...(opts.opening ? { $opening: true } : {}), operations: [{ type: 0, to: acct(BASE), token: acct(BASE), amount: 1n }] },
  { account: acct(SH), hash: hx(`P${n}`), previous: hx(`F${n}`), operations: [{ type: 0, to: acct(`keeta_w${n}`), token: acct(KORE), amount: 5n, external: `kore-keeta_w${n}-${n}` }] },
]);
const dep = (n, iso) => row(`D${n}`, iso, [{ account: acct("keeta_depositor"), hash: hx(`DB${n}`), operations: [{ type: 0, to: acct(SH), token: acct(BASE), amount: 9n }] }]);
const hist = [pay(6, "2026-11-03T00:20:00Z"), dep(2, "2026-11-03T00:15:00Z"), pay(5, "2026-11-03T00:12:00Z"), pay(4, "2026-11-03T00:11:00Z"), dep(1, "2026-11-02T10:00:00Z"), pay(3, "2026-11-02T00:10:00Z"), pay(2, "2026-11-02T00:09:00Z")];
const pager = (rs, size = 100) => ({ client: { getHistory: async (a, { startBlocksHash }) => { const i = startBlocksHash ? rs.findIndex((x) => x.voteStaple.blocksHash.toString() === startBlocksHash) + 1 : 0; return rs.slice(i, i + size); } } });
const since = Date.parse("2026-11-03T00:00:00Z");
const fk = (rs, o = {}) => findKeyedSends(pager(rs), SH, { sinceMs: since, koreText: KORE, ...o });
const full = await fk(hist);
check("R-1 a whole chain (fee + payout blocks, deposits between) is complete, head is the newest shaft block", full.complete && full.head === "P6" && full.sends.map((x) => x.externals[0]).join() === "kore-keeta_w6-6,kore-keeta_w5-5,kore-keeta_w4-4");
const gap = await fk(hist.filter((r) => r.voteStaple.blocksHash.toString() !== "T5"));
check("R-1 a middle shaft row dropped (older rows still there): NOT complete, the gap is named", gap.complete === false && /a row is missing/.test(gap.broken));
const gapOld = await fk(hist.filter((r) => r.voteStaple.blocksHash.toString() !== "T3"));
check("R-1 the first row older than the start dropped: NOT complete (the old row must hold the next link)", gapOld.complete === false && /a row is missing/.test(gapOld.broken));
const depGone = await fk(hist.filter((r) => r.voteStaple.blocksHash.toString() !== "D2"));
check("R-1 a deposit row (not the shaft's block) dropped: the chain cannot see it, still complete (payout search is unaffected)", depGone.complete === true);
const half = hist.map((r) => (r.voteStaple.blocksHash.toString() === "T5" ? row("T5", "2026-11-03T00:12:00Z", [r.voteStaple.blocks[1]]) : r));
const h2 = await fk(half);
check("R-1 a staple that comes back with one of its two shaft blocks: NOT complete", h2.complete === false);
// A staple with a stray third shaft block (C5, not linked to the others): two newest blocks, so the staple is refused.
const fork = hist.map((r) => (r.voteStaple.blocksHash.toString() === "T5" ? row("T5", "2026-11-03T00:12:00Z", [...r.voteStaple.blocks, { account: acct(SH), hash: hx("C5"), previous: hx("Z9"), operations: [] }]) : r));
const fk5 = await fk(fork);
check("R-1 a staple with a stray shaft block not on the chain (two newest blocks): NOT complete, named", fk5.complete === false && /no single newest block/.test(fk5.broken), JSON.stringify(fk5.broken));
const long = Array.from({ length: 160 }, (_, k) => pay(200 - k, new Date(Date.parse("2026-11-03T05:00:00Z") - k * 60_000).toISOString())).concat([pay(40, "2026-11-02T00:00:00Z")]);
// the 160 newer rows run P200 .. P41 (F41's previous is P40, in the old row)
const paged = await fk(long);
check("R-1 the chain holds across a page turn (100 + 61 rows)", paged.complete === true && paged.head === "P200" && paged.sends.length === 160);
const pagedGap = await fk(long.filter((r, k) => k !== 100));
check("R-1 a row dropped right at the page turn: NOT complete", pagedGap.complete === false);
const opened = [pay(6, "2026-11-03T00:20:00Z"), pay(5, "2026-11-03T00:12:00Z", { opening: true })];
const op = await fk(opened);
check("N-4 the shaft's opening block is newer than the start: never complete (hold), the chain has nothing older", op.complete === false);
const op2 = await fk([...opened, pay(4, "2026-11-02T00:12:00Z")]);
check("R-1 a row below the opening block breaks the chain", op2.complete === false && /opening/.test(op2.broken));
const headC = (heads) => ({ client: { representatives: heads.map((h, i) => ({ endpoints: { api: `r${i}` }, h })), getAccountHeadInfo: async (a, rep) => { if (rep.h === "error") throw new Error("down"); return rep.h === null ? null : { block: { hash: hx(rep.h) } }; } } });
check("R-1 head agreed by every rep", (await headAgreed(headC(["P6", "P6", "P6"]), SH, "P6")).ok === true);
check("R-1 one rep lags: not agreed", (await headAgreed(headC(["P6", "P5", "P6"]), SH, "P6")).ok === false);
check("R-1 the walk's head is behind every rep: not agreed", (await headAgreed(headC(["P7", "P7"]), SH, "P6")).ok === false);
check("R-1 a rep errors or has no head: not agreed", (await headAgreed(headC(["P6", "error"]), SH, "P6")).ok === false && (await headAgreed(headC(["P6", null]), SH, "P6")).ok === false);
check("R-1 no reps, or no head from the walk: not agreed", (await headAgreed(headC([]), SH, "P6")).ok === false && (await headAgreed(headC(["P6"]), SH, "")).ok === false);
check("Ops F2 one known rep, even one that agrees: not agreed (fewer than 2)", (await headAgreed(headC(["P6"]), SH, "P6")).ok === false && /fewer than 2/.test((await headAgreed(headC(["P6"]), SH, "P6")).why) && (await headAgreed(headC(["P6", "P6"]), SH, "P6")).ok === true);
console.log("chain fire ok");
