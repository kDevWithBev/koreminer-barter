// Box 2b read-only preflight: the staged pit code on the server's own node and SDK, before box 3 touches anything.
// node pit-preflight.mjs <stage> <runner dir>. Builds a temp code tree (the runner's *.mjs + the staged code + a link to the
// runner's node_modules), checks every SDK call the pit makes exists, reads one real fire history page, then runs one TEST
// pass with a read-only client (no signer, no seed, cannot publish) into a temp state folder, and deletes the temp tree.
// Prints PREFLIGHT_OK pass_ms=<n> or PREFLIGHT_FAIL <reason>. Never reads seed.txt or .env; writes only under the temp tree.
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [G, D] = process.argv.slice(2);
const T = mkdtempSync("/tmp/pit-preflight-");
const out = (s) => console.log(s);
const done = (line, code) => { try { rmSync(T, { recursive: true, force: true }); } catch {} out(line); process.exit(code); };
const timer = setTimeout(() => done("PREFLIGHT_FAIL timed out after 240 s", 1), 240_000);
try {
  const C = `${T}/code`; mkdirSync(C);
  for (const f of readdirSync(D)) if (/^[\w.-]+\.mjs$/.test(f)) cpSync(`${D}/${f}`, `${C}/${f}`);
  for (const f of ["chain.mjs", "pit.mjs", "pit-run.mjs", "ladder.mjs", "sdk-contract.mjs"]) cpSync(`${G}/${f}`, `${C}/${f}`);
  symlinkSync(`${D}/node_modules`, `${C}/node_modules`);
  const entry = createRequire(`${D}/x.js`).resolve("@keetanetwork/keetanet-client");
  const ver = JSON.parse(readFileSync(entry.replace(/client\/index\.js$/, "package.json"), "utf8")).version;
  const imd5 = createHash("md5").update(readFileSync(entry)).digest("hex");
  out(`sdk ${ver} index.js ${imd5.slice(0, 8)}`);
  const m = await import(pathToFileURL(entry).href); const KN = m.default ?? m;
  const sc = await import(`${C}/sdk-contract.mjs`); const { ADDR } = await import(`${C}/pit.mjs`);
  const { pullSince, findKeyedSends, headAgreed } = await import(`${C}/chain.mjs`); const { runPit, readConfig } = await import(`${C}/pit-run.mjs`);
  if (ver !== sc.SDK_VERSION) done(`PREFLIGHT_FAIL sdk ${ver} is not ${sc.SDK_VERSION}`, 1);
  // Sage N-3: the exact SDK build the code was checked against, not only its version number.
  if (!sc.SDK_INDEX_MD5 || imd5 !== sc.SDK_INDEX_MD5) done(`PREFLIGHT_FAIL sdk client/index.js md5 ${imd5.slice(0, 8)} is not ${String(sc.SDK_INDEX_MD5).slice(0, 8)}`, 1);
  const uc = sc.readOnlyClient(KN, ADDR.intake);
  const miss = sc.sdkMissing(KN, uc);
  const src = (n) => readFileSync(`${C}/${n}`, "utf8"); const ch = src("chain.mjs");
  for (const c of [...sc.callsIn(ch.slice(ch.indexOf("// ---- pit"))), ...sc.callsIn(src("pit-run.mjs")), ...sc.callsIn(src("pit.mjs"))]) if (!sc.KNOWN_CALLS.has(c)) miss.push(`${c} (called, not in the contract)`);
  out(`missing: ${miss.length ? miss.join(", ") : "none"}`); if (miss.length) done(`PREFLIGHT_FAIL missing ${miss.join(", ")}`, 1);
  const cfg = JSON.parse(readFileSync(`${G}/ops/pit-config.test-tuesday.json`, "utf8"));
  let t = Date.now(); const f = await pullSince(uc, ADDR.sink, { stopBeforeMs: Date.parse(`${cfg.pitDay1}T00:00:00Z`) });
  out(`fire history: complete ${f.complete}, ${f.rows.length} rows since ${cfg.pitDay1}, ${Date.now() - t} ms`);
  if (!f.complete) done("PREFLIGHT_FAIL fire history did not reach a row before pit day 1", 1);
  // R-1: the shaft walk must link block to block and every rep must report its head (the gate before any void).
  t = Date.now(); const h = await findKeyedSends(uc, ADDR.intake, { sinceMs: Date.now() - 2 * 86_400_000, koreText: ADDR.kore });
  const ag = h.complete ? await headAgreed(uc, ADDR.intake, h.head) : { ok: false, why: "walk incomplete" };
  out(`shaft walk: complete ${h.complete}${h.broken ? ` (${h.broken})` : ""}, head ${String(h.head ?? "none").slice(0, 8)}, reps agree ${ag.ok}${ag.ok ? "" : ` (${ag.why})`}, ${Date.now() - t} ms`);
  if (!h.complete || !ag.ok) done("PREFLIGHT_FAIL the shaft hash-chain walk or the rep head check did not pass", 1);
  // A LIVE config in the stage (the upgrade stage) must read as live, pitDay1-1 ladder, start at 00:00Z.
  if (existsSync(`${G}/ops/pit-config.live-wednesday.json`)) {
    const L = `${T}/live`; mkdirSync(L); cpSync(`${G}/ops/pit-config.live-wednesday.json`, `${L}/pit-config.json`);
    const lc = readConfig(L); const li = JSON.parse(readFileSync(`${G}/ops/pit-init.live-wednesday`, "utf8"));
    out(`live config: ${lc.test ? "test" : "live"} ${lc.pitDay1} ladderLast ${lc.ladderLast} start ${new Date(lc.startMs).toISOString()}, init ${li.mode} ${li.pitDay1}`);
    if (lc.test || li.mode !== "live" || li.pitDay1 !== lc.pitDay1 || lc.pitDay1 !== "2026-10-29" || li.legacyUntil !== undefined) done("PREFLIGHT_FAIL the LIVE config or pit-init is not live 2026-10-29", 1);
  }
  const S = `${T}/d`; mkdirSync(`${S}`); mkdirSync(`${T}/pub`);
  writeFileSync(`${S}/pit-config.json`, JSON.stringify({ ...cfg, ladderSeed: `${G}/${cfg.ladderSeed.replace(/^.*\/fixtures\//, "fixtures/")}`, publicDir: `${T}/pub` }));
  cpSync(`${G}/ops/pit-init.test-tuesday`, `${S}/pit-init`);
  const base = KN.lib.Account.generateBaseAddresses(0x5382n).baseToken; const warns = [];
  t = Date.now(); let pass = null;
  await runPit({ dir: S, client: uc, base, baseText: base.publicKeyString.toString(), koreAccount: KN.lib.Account.fromPublicKeyString(ADDR.kore),
    accountFrom: (id) => KN.lib.Account.fromPublicKeyString(id), steps: 1, sleep: async () => {}, log: () => {}, warn: (w) => warns.push(String(w)) });
  pass = Date.now() - t;
  const looked = existsSync(`${S}/pit-test/pit-lookup.json`);
  out(`test pass: ${pass} ms, pit-lookup ${looked ? "written" : "MISSING"}, warnings ${warns.length}${warns.length ? `: ${warns.slice(0, 3).join(" | ").slice(0, 300)}` : ""}`);
  if (!looked || warns.length) done("PREFLIGHT_FAIL the TEST pass did not finish clean", 1);
  if (pass > 60_000) done(`PREFLIGHT_FAIL the TEST pass took ${pass} ms (box 3 waits 180 s, which must be 3x the pass)`, 1);
  clearTimeout(timer); done(`PREFLIGHT_OK pass_ms=${pass}`, 0);
} catch (e) { done(`PREFLIGHT_FAIL ${String(e?.message ?? e).slice(0, 300)}`, 1); }
