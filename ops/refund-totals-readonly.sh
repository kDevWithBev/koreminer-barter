#!/usr/bin/env bash
# Koreminer refund totals, READ-ONLY. Paste on the Hostinger server as root.
# Reads ONLY these fields by key name, with node:
#   /opt/koreminer/books.json : stake, depth, lots[].from, reserve, operator, parked, unresolved[].{amount,time,t}, pendingDrops, lastMs
#   /opt/koreminer/links.json : base address -> keeta (public addresses only; nonce/date not printed)
# Plus the shaft's public KTA balance from the public Keeta API (curl).
# Writes nothing, changes no service, never prints seed.txt, sink.txt, .env, env or a whole file.
# Ends with: REFUND_TOTALS_READONLY_DONE
D=/opt/koreminer
SHAFT=keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa
KTA_TOKEN=keeta_anqdilpazdekdu4acw65fj7smltcp26wbrildkqtszqvverljpwpezmd44ssg
echo "===== Koreminer refund totals (read-only) $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
echo "runner: $(systemctl is-active koreminer 2>/dev/null)  (if active, books may move while this runs)"
for f in STOP HALT PAYHOLD FEEHOLD PICKS_OFF payout-intent.json; do [ -e $D/$f ] && echo "present: $D/$f"; done
[ -r $D/books.json ] || { echo "books.json not readable at $D"; echo REFUND_TOTALS_READONLY_DONE; exit 1; }
CHAIN_HEX=$(curl -fsS --max-time 20 -A curl/8.5.0 "https://rep2.main.network.api.keeta.com/api/node/ledger/account/$SHAFT/balance" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const b=(j.balances||[]).find(x=>x.token===process.argv[1]);process.stdout.write(b?String(b.balance):"")}catch{}})' "$KTA_TOKEN")
if [ -n "$CHAIN_HEX" ]; then echo "on-chain fetch: ok"; else echo "on-chain fetch: FAILED (table still prints)"; fi
echo
cd $D && node - "$D" "$CHAIN_HEX" <<'JS'
// Reads only named fields of books.json and links.json. Prints no secrets.
const fs = require("fs");
const D = process.argv[2]; const chainHex = process.argv[3] || "";
const E = 10n ** 18n;
const kta = (r) => { const neg = r < 0n; const a = neg ? -r : r; return (neg ? "-" : "") + (a / E) + "." + (a % E).toString().padStart(18, "0").slice(0, 6); };
const big = (v) => { try { return BigInt(v ?? "0"); } catch { return 0n; } };
let books;
try { books = JSON.parse(fs.readFileSync(D + "/books.json", "utf8")); } catch (e) { console.log("books.json unreadable:", e.code || "parse error"); process.exit(1); }
let links = {};
try { const l = JSON.parse(fs.readFileSync(D + "/links.json", "utf8")); if (l && typeof l === "object" && !Array.isArray(l)) links = l; } catch { /* none */ }
const BRIDGE = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const SHARED_EXACT = {
  [BRIDGE]: "Keeta EVM-anchor bridge account (many Base users)",
  "0xfe6d5e3f8cff2dc8d2dea137c87f721c69343d7d": "shaft's own Base address",
  "0x1c24a0fb7bcf2154a9d37b7b3aa443bc63fcc698": "Base bridge contract",
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789": "ERC-4337 EntryPoint (shared)",
};
// Partial addresses from our notes (prefix...suffix). Coinbase withdrawals come from hot wallets.
const SHARED_PATTERN = [["0xb480", "07fb", "possible Coinbase hot wallet (0xB480…07fB)"]];
const sharedNote = (addr) => {
  const a = String(addr).replace(/^base:/, "").toLowerCase();
  if (SHARED_EXACT[a]) return SHARED_EXACT[a];
  for (const [p, s, n] of SHARED_PATTERN) if (a.startsWith(p) && a.endsWith(s)) return n;
  return "";
};
const stake = books.stake || {}, depth = books.depth || {};
const lots = Array.isArray(books.lots) ? books.lots : [];
// deposit-from sources per miner key: the key itself + linked Base addresses
const srcOf = {}; const linkedTo = {};
for (const [base, row] of Object.entries(links)) {
  const k = row && typeof row.keeta === "string" ? row.keeta : "";
  if (!k) continue;
  (srcOf[k] ||= new Set()).add(base.toLowerCase());
  (linkedTo[base.toLowerCase()] ||= new Set()).add(k);
}
const keys = new Set([...Object.keys(stake), ...Object.keys(depth), ...lots.map((l) => l.from)]);
const rows = [];
for (const k of keys) {
  const unburned = big(stake[k]); const burned = big(depth[k]);
  if (unburned === 0n && burned === 0n) continue;
  const sources = new Set([k.startsWith("base:") ? k.slice(5) : k, ...(srcOf[k] || [])]);
  const flags = [];
  for (const s of sources) { const n = sharedNote(s); if (n) flags.push(`${s.slice(0, 14)}…: ${n}`); }
  for (const s of sources) if (linkedTo[s] && linkedTo[s].size > 1) flags.push(`${s.slice(0, 14)}… linked to ${linkedTo[s].size} miners`);
  if (k.startsWith("base:")) flags.push("unlinked Base sender (not payable until linked)");
  const nLots = lots.filter((l) => l.from === k).length;
  rows.push({ k, sources: [...sources], dep: unburned + burned, burned, unburned, nLots, flags });
}
// a source address that shows up under more than one miner key
const seen = {};
for (const r of rows) for (const s of r.sources) (seen[s] ||= []).push(r.k);
for (const r of rows) for (const s of r.sources) if (seen[s].length > 1) r.flags.push(`${s.slice(0, 14)}… appears under ${seen[s].length} miner keys (${seen[s].map((x) => x.slice(0, 14)).join(" + ")})`);
rows.sort((a, b) => (b.unburned > a.unburned ? 1 : b.unburned < a.unburned ? -1 : 0));
let T = { dep: 0n, burned: 0n, unburned: 0n };
const pad = (s, n) => String(s).padEnd(n), lp = (s, n) => String(s).padStart(n);
console.log(pad("miner (books key)", 22), lp("deposited", 16), lp("burned", 16), lp("unburned", 16), lp("lots", 5), " deposit-from / flags");
for (const r of rows) {
  T.dep += r.dep; T.burned += r.burned; T.unburned += r.unburned;
  console.log(pad(r.k.slice(0, 20) + "…", 22), lp(kta(r.dep), 16), lp(kta(r.burned), 16), lp(kta(r.unburned), 16), lp(r.nLots, 5), " " + r.sources.map((s) => s.slice(0, 14) + "…").join(", ") + (r.flags.length ? "  FLAG: " + r.flags.join("; ") : ""));
}
console.log(pad("TOTAL miners", 22), lp(kta(T.dep), 16), lp(kta(T.burned), 16), lp(kta(T.unburned), 16), lp(rows.length, 5));
const reserve = big(books.reserve), operator = big(books.operator), parked = big(books.parked);
const pend = (books.pendingDrops || []).reduce((s, d) => s + big(d), 0n);
const accounted = T.unburned + reserve + operator + parked;
console.log("");
console.log("reserve (2 KTA, not refundable to anyone)   ", kta(reserve));
console.log("operator (pre-launch deposits, dust, ours)  ", kta(operator));
console.log("parked (uncredited bridge deliveries)       ", kta(parked), " items:", (books.unresolved || []).length);
for (const u of (books.unresolved || []).slice(0, 20)) console.log("   parked item: amount", kta(big(u.amount)), "time", u.time ? new Date(Number(u.time)).toISOString() : "?", "base tx", String(u.t || "").slice(0, 18) + "…");
console.log("pending drops (published, not yet burned)   ", kta(pend), " count", (books.pendingDrops || []).length);
console.log("books total = unburned + reserve + operator + parked =", kta(accounted));
console.log("books lastMs", books.lastMs ? new Date(Number(books.lastMs)).toISOString() : "?", " linked Base addresses:", Object.keys(links).length);
let chain = null;
if (/^0x[0-9a-fA-F]+$/.test(chainHex)) chain = BigInt(chainHex);
if (chain === null) console.log("on-chain KTA balance: UNAVAILABLE");
else {
  console.log("on-chain KTA balance (public API)           ", kta(chain));
  console.log("difference chain - books total              ", kta(chain - accounted), chain - accounted === 0n ? "(match)" : "(after pending drops: " + kta(chain - accounted + pend) + ")");
}
console.log("\n--- CSV ---");
console.log("miner,deposit_from,deposited_kta,burned_kta,unburned_kta,lots,flags");
for (const r of rows) console.log([r.k, r.sources.join(" "), kta(r.dep), kta(r.burned), kta(r.unburned), r.nLots, '"' + r.flags.join("; ").replace(/"/g, "'") + '"'].join(","));
console.log(["TOTAL", "", kta(T.dep), kta(T.burned), kta(T.unburned), "", ""].join(","));
console.log(["reserve", "", "", "", kta(reserve), "", ""].join(","));
console.log(["operator", "", "", "", kta(operator), "", ""].join(","));
console.log(["parked", "", "", "", kta(parked), "", ""].join(","));
console.log(["books_total", "", "", "", kta(accounted), "", ""].join(","));
console.log(["chain_balance", "", "", "", chain === null ? "" : kta(chain), "", ""].join(","));
console.log(["difference", "", "", "", chain === null ? "" : kta(chain - accounted), "", ""].join(","));
console.log("--- END CSV ---");
JS
echo
echo "Notes: deposited = unburned (stake) + burned (depth) per books key. The 2 KTA reserve came out of the first deposit(s) and"
echo "deposits before arm (2026-10-10) went to operator, so neither shows per miner. Base-bridge deposits are keyed base:0x<sender>"
echo "until linked at /claim, then merged into the linked keeta key (links.json lists the Base sources)."
echo REFUND_TOTALS_READONLY_DONE
