// Contract test against the REAL @keetanetwork/keetanet-client the server runs (0.18.7), so a fake client cannot hide a
// missing SDK call again. The network is replayed from real mainnet responses (fixtures/sdk-replay-0.18.7.json); any other
// request fails the test. Set KEETA_SDK to a node_modules folder that has the SDK if it is not next to this file.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CLIENT_CALLS, KNOWN_CALLS, SDK_VERSION, callsIn, readOnlyClient, sdkMissing } from "./sdk-contract.mjs";
import { findKeyedSends, headAgreed, pullSince, readFireStaple } from "./chain.mjs";
import { ADDR } from "./pit.mjs";

let bad = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !info ? "" : ` - ${info}`}`); if (!ok) bad += 1; };
const js = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? String(x) : x)).slice(0, 200);
const here = new URL(".", import.meta.url).pathname;
let entry;
try { entry = createRequire(process.env.KEETA_SDK ? `${process.env.KEETA_SDK.replace(/\/node_modules\/?$/, "")}/x.js` : `${here}x.js`).resolve("@keetanetwork/keetanet-client"); } catch { entry = null; }
if (!entry) { console.log("FAIL the real SDK is not loadable (set KEETA_SDK); this test never passes on a fake"); console.log("SDK_CONTRACT_FAIL 1"); process.exit(1); }
const pkg = JSON.parse(readFileSync(entry.replace(/client\/index\.js$/, "package.json"), "utf8"));
check(`SDK is the server's version ${SDK_VERSION}`, pkg.version === SDK_VERSION, pkg.version);
check("SDK client/index.js md5 is the server's (4ccd1d46)", createHash("md5").update(readFileSync(entry)).digest("hex") === "4ccd1d4637c00aec945a499492ed4fee");
const mod = await import(pathToFileURL(entry).href);
const KN = mod.default ?? mod;

const fx = JSON.parse(readFileSync(`${here}fixtures/sdk-replay-0.18.7.json`, "utf8"));
const asked = [];
const hosts = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url)); asked.push(u.pathname + u.search); hosts.push(`${u.hostname.split(".")[0]} ${u.pathname}`);
  if (u.pathname.endsWith("/node/ledger/representatives")) return new Response(fx.representatives, { status: 200 });
  const hd = u.pathname.match(/\/node\/ledger\/account\/(keeta_\w+)\/head$/);
  const rep = u.hostname.split(".")[0];
  if (hd && hd[1] === ADDR.intake && fx.heads[rep]) return new Response(fx.heads[rep], { status: 200 });
  const m = u.pathname.match(/\/node\/ledger\/account\/(keeta_\w+)\/history$/);
  const page = m && fx.history[`${m[1]}|${u.searchParams.get("start") ?? ""}`];
  if (page) return new Response(JSON.stringify(page), { status: 200 });
  throw new Error(`no network in this test: ${u.pathname}${u.search}`);
};

const uc = readOnlyClient(KN, ADDR.intake);
const miss = sdkMissing(KN, uc);
check("every SDK call the pit runner makes exists on the real UserClient / Client / Builder", miss.length === 0, miss.join(", "));
check("the real UserClient has no getHistory of its own (history of other accounts is client.client.getHistory)", typeof uc.getHistory !== "function" && CLIENT_CALLS.indexOf("getHistory") === -1);
const chain = readFileSync(`${here}chain.mjs`, "utf8");
const used = [...callsIn(chain.slice(chain.indexOf("// ---- pit"))), ...callsIn(readFileSync(`${here}pit-run.mjs`, "utf8")), ...callsIn(readFileSync(`${here}pit.mjs`, "utf8"))];
const unknown = used.filter((c) => !KNOWN_CALLS.has(c));
// Ops N-8: a call made through another name for the client or a builder is not missed by the scan.
const al = [...callsIn("const c = client;\nc.getHistory(1);\nconst { balance } = client;\nfoo(client);\nclient[\"x\"]();\nconst n = client.client;\n")];
check("N-8 the scan reports the client copied, destructured, handed on, indexed, and client.client used bare", ["const c = client;", "const { balance } = client;", "foo(client);", "client[\"x\"]();"].every((l) => al.includes(`alias: ${l}`)) && al.some((c) => c.startsWith("alias: client.client used bare")), JSON.stringify(al));
const ba = [...callsIn("const b2 = client.initBuilder();\nb2.sendAll(1);\nawait client.initBuilder().computeFeeBlock(x);\nclient.client?.getVersion();\n")];
check("N-8 the scan follows a builder kept under another name, a chained builder call, and client.client?.", ["builder.sendAll", "builder.computeFeeBlock", "client.client.getVersion"].every((c) => ba.includes(c)) && !ba.some((c) => c.startsWith("alias:")), JSON.stringify(ba));
check("N-8 the walkers handed the client, and function parameters, are not flagged", [...callsIn("async function f(client, x) {\n  return pullSince(client, a, {});\n}\nheadAgreed(client, a, h);\n")].every((c) => !c.startsWith("alias:")));
check("pit-run.mjs, pit.mjs and the pit half of chain.mjs call nothing on the client that this contract does not check", unknown.length === 0 && used.includes("client.client.getHistory"), unknown.join(", "));
const unused = [...KNOWN_CALLS].filter((c) => !used.includes(c));
check("the contract lists exactly the calls the pit code makes (none stale, none missed by the scan)", unused.length === 0, unused.join(", "));

const fire = await pullSince(uc, ADDR.sink, { stopBeforeMs: Date.parse("2026-10-27T00:00:00Z") }).catch((e) => ({ err: e.message }));
check("real SDK: fire history back to pit day 1 is complete (its newest row is older)", fire.complete === true && fire.rows.length === 0, js(fire));
const rows = await uc.client.getHistory(ADDR.sink, { depth: 100 });
const st = readFireStaple(rows[0], { fire: ADDR.sink, baseText: "x", koreText: ADDR.kore });
check("real SDK: a real fire staple reads (blocksHash, timestamp)", !!st && new Date(st.timeMs).toISOString() === fx.expect.fireNewest);
// The shaft: its newest rows exactly as the node returned them (none left out), over 2 pages and the empty end page. The walk
// must follow the shaft's hash chain (fee block + payout block per staple) down to the first row older than the start.
const since = Date.parse(fx.expect.since);
const sh = await findKeyedSends(uc, ADDR.intake, { sinceMs: since, koreText: ADDR.kore }).catch((e) => ({ err: e.message }));
check("real SDK: shaft history walks 2 pages, follows the shaft's hash chain to a row older than the start, is complete", sh.complete === true && !sh.broken && asked.some((a) => a.includes(`${ADDR.intake}/history`) && a.includes("start=")), js(sh));
check("real SDK: the walk's head is the shaft head the node reports", sh.head === fx.expect.head, sh.head);
const keys = (sh.sends ?? []).map((s) => s.externals[0]);
check("real SDK: payout keys come back as plain text kore-<wallet>-<n> (Ops N-1), one per payout staple", keys.length === 3 && keys.every((k) => /^kore-keeta_\w+-\d+$/.test(k)), JSON.stringify(keys));
check("real SDK: each keyed send reads its wallet and a KORE amount", (sh.sends ?? []).length === 3 && sh.sends.every((s) => s.to.startsWith("keeta_") && s.amount > 0n && s.externals[0] === `kore-${s.to}-${s.externals[0].split("-").pop()}`));
await uc.client.updateReps?.();
const agreed = await headAgreed(uc, ADDR.intake, sh.head).catch((e) => ({ ok: false, why: e.message }));
check("real SDK: every rep (4, each asked by its own URL) agrees on the shaft head (Ops R-1 freshness gate)", agreed.ok === true && agreed.reps === 4 && ["rep1", "rep2", "rep3", "rep4"].every((r) => hosts.includes(`${r} /api/node/ledger/account/${ADDR.intake}/head`)), js(agreed));
// Ops R-1 + the trimmed-fixture flag: the same real rows with one payout row left out must NOT be complete.
const page2 = Object.keys(fx.history).find((k) => k.startsWith(`${ADDR.intake}|`) && k !== `${ADDR.intake}|` && fx.history[k].history.length === 3);
const saved = fx.history[page2];
fx.history[page2] = { ...saved, history: [saved.history[0], saved.history[2]] };
const gap = await findKeyedSends(uc, ADDR.intake, { sinceMs: since, koreText: ADDR.kore }).catch((e) => ({ err: e.message }));
check("real SDK: a payout row left out of the middle (older rows still there) is NOT complete", gap.complete === false && /a row is missing/.test(gap.broken ?? ""), js(gap));
fx.history[page2] = { ...saved, history: saved.history.slice(0, 2) };
const noOld = await findKeyedSends(uc, ADDR.intake, { sinceMs: since, koreText: ADDR.kore }).catch((e) => ({ err: e.message }));
check("real SDK: the history ends before a row older than the start (trimmed): NOT complete", noOld.complete === false, js(noOld));
fx.history[page2] = saved;
const lagged = { ...fx.heads };
// A rep with no head for the shaft (the recorded body with its block removed), then a walk head that is not the reps' head.
fx.heads.rep3 = JSON.stringify({ ...JSON.parse(lagged.rep3), block: null });
const lag = await headAgreed(uc, ADDR.intake, sh.head).catch((e) => ({ ok: false, why: e.message }));
check("real SDK: one rep with no head for the shaft: not agreed", lag.ok === false, js(lag));
fx.heads.rep3 = lagged.rep3;
const wrong = await headAgreed(uc, ADDR.intake, "AA67CB53" + "0".repeat(56)).catch((e) => ({ ok: false, why: e.message }));
check("real SDK: a walk head that is not the reps' head (the newest payout row left out): not agreed", wrong.ok === false && /DF81CE9A/i.test(wrong.why), js(wrong));
fx.heads = lagged;
console.log(bad ? `SDK_CONTRACT_FAIL ${bad}` : "SDK_CONTRACT_PASS");
process.exit(bad ? 1 : 0);
