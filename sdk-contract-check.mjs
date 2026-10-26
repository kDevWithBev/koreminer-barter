// Contract test against the REAL @keetanetwork/keetanet-client the server runs (0.18.7), so a fake client cannot hide a
// missing SDK call again. The network is replayed from real mainnet responses (fixtures/sdk-replay-0.18.7.json); any other
// request fails the test. Set KEETA_SDK to a node_modules folder that has the SDK if it is not next to this file.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CLIENT_CALLS, KNOWN_CALLS, SDK_VERSION, callsIn, readOnlyClient, sdkMissing } from "./sdk-contract.mjs";
import { findKeyedSends, pullSince, readFireStaple } from "./chain.mjs";
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
globalThis.fetch = async (url) => {
  const u = new URL(String(url)); asked.push(u.pathname + u.search);
  if (u.pathname.endsWith("/node/ledger/representatives")) return new Response(fx.representatives, { status: 200 });
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
check("pit-run.mjs, pit.mjs and the pit half of chain.mjs call nothing on the client that this contract does not check", unknown.length === 0 && used.includes("client.client.getHistory"), unknown.join(", "));
const unused = [...KNOWN_CALLS].filter((c) => !used.includes(c));
check("the contract lists exactly the calls the pit code makes (none stale, none missed by the scan)", unused.length === 0, unused.join(", "));

const fire = await pullSince(uc, ADDR.sink, { stopBeforeMs: Date.parse("2026-10-27T00:00:00Z") }).catch((e) => ({ err: e.message }));
check("real SDK: fire history back to pit day 1 is complete (its newest row is older)", fire.complete === true && fire.rows.length === 0, js(fire));
const rows = await uc.client.getHistory(ADDR.sink, { depth: 100 });
const st = readFireStaple(rows[0], { fire: ADDR.sink, baseText: "x", koreText: ADDR.kore });
check("real SDK: a real fire staple reads (blocksHash, timestamp)", !!st && new Date(st.timeMs).toISOString() === fx.expect.fireNewest);
const sh = await findKeyedSends(uc, ADDR.intake, { sinceMs: Date.parse("2026-10-25T12:00:00Z"), koreText: ADDR.kore }).catch((e) => ({ err: e.message }));
check("real SDK: shaft history walks 2 pages to a row older than the start and is complete", sh.complete === true && asked.some((a) => a.includes(`${ADDR.intake}/history`) && a.includes("start=")), js(sh));
const keys = (sh.sends ?? []).map((s) => s.externals[0]);
check("real SDK: payout keys come back as plain text kore-<wallet>-<n> (Ops N-1)", JSON.stringify(keys) === JSON.stringify(fx.expect.keyed) && keys.every((k) => /^kore-keeta_\w+-\d+$/.test(k)), JSON.stringify(keys));
check("real SDK: each keyed send reads its wallet and a KORE amount", (sh.sends ?? []).length === 3 && sh.sends.every((s) => s.to.startsWith("keeta_") && s.amount > 0n && s.externals[0] === `kore-${s.to}-${s.externals[0].split("-").pop()}`));
console.log(bad ? `SDK_CONTRACT_FAIL ${bad}` : "SDK_CONTRACT_PASS");
process.exit(bad ? 1 : 0);
