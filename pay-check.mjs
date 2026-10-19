import { startMs } from "./ledger.mjs";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESERVE, accrue, createShare, deposit, due, whole } from "./share.mjs";
import { applyPaid, choosePayout, feeFits, floorAfter, judgeIntent } from "./pay.mjs";

const DAY = 86_400_000;
const open = startMs;
const kta = (n) => BigInt(n) * 10n ** 18n;
const intake = "keeta_aabxtne7hbivzeknf3c6dw7rb7uiln7pbntwubrwccb7uz62ihjlmlaordxh6fa";
const sink = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";

function check(name, ok) {
  if (!ok) throw new Error(name);
  console.log("ok", name);
}

const state = createShare(open);
deposit(state, "reserve", kta(2), open);
deposit(state, intake, kta(100), open);
deposit(state, sink, kta(100), open);
deposit(state, "keeta_alice", kta(10), open);
deposit(state, "keeta_bob", kta(30), open);
deposit(state, "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle", kta(23), open);
accrue(state, open + DAY);

const row = choosePayout(state, { intake, sink });
check("the larger miner is first", row.from === "keeta_bob");
check("the shaft is not paid", row.from !== intake && row.from !== sink);
check("the bridge is not paid", row.from !== "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle");
check("bob is paid his whole due", row.amount === due(state, "keeta_bob") && row.amount > 0n);
const next = choosePayout(state, { intake, sink, skip: ["keeta_bob"] });
check("a wallet already sent is skipped", next.from === "keeta_alice");

check("a fee that touches the reserve is refused", feeFits(2_000n, 1n, 2_000n) === false);
check("a fee above the reserve is allowed", feeFits(2_001n, 1n, 2_000n) === true);
check("the floor is the balance minus the payout", floorAfter(21_000_000n, row.amount) === 21_000_000n - row.amount);
check("a payout bigger than the wallet is refused", floorAfter(10n, 11n) === null);

const intent = { from: "keeta_bob", amount: row.amount.toString(), floor: (21_000_000n - row.amount).toString() };
check("a landed send is paid", judgeIntent(21_000_000n - row.amount, intent) === "paid");
check("a missed send is not paid", judgeIntent(21_000_000n, intent) === "missed");
check("any other drop holds", judgeIntent(20_000_000n, intent) === "hold");
check("the payout key is the server form", row.key === `kore-${row.from}-${whole(state.pending.get(row.from))}`);

check("marking the payout clears it", applyPaid(state, intent) === "marked");
check("bob is no longer due", due(state, "keeta_bob") === 0n);
check("a repeated payout is already clear", applyPaid(state, intent) === "done");
check("alice is still due", due(state, "keeta_alice") > 0n);
check("the reserve constant is 2 KTA", RESERVE === kta(2));

const baseKey = "base:0xfe6d5e3f8cff2dc8d2dea137c87f721c69343d7d";
const bridgeKey = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const heldPay = createShare(open);
deposit(heldPay, "reserve", kta(2), open);
deposit(heldPay, "keeta_alice", kta(10), open);
deposit(heldPay, bridgeKey, kta(23), open);
deposit(heldPay, baseKey, kta(40), open);
accrue(heldPay, open + DAY);
const picked = choosePayout(heldPay, { intake, sink });
check("payout still skips the bridge", picked.from !== bridgeKey);
check("payout still skips a base key", picked.from !== baseKey && !String(picked.from).startsWith("base:"));
check("payout still chooses the keeta miner", picked.from === "keeta_alice" && picked.amount === due(heldPay, "keeta_alice"));

const runSrc = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
const holdStart = runSrc.indexOf("function holdPayouts(reason) {");
const holdEnd = runSrc.indexOf("\nfunction settlePayout", holdStart);
const holdBody = runSrc.slice(holdStart, holdEnd);
const holdDir = mkdtempSync(join(tmpdir(), "kore-hold-"));
const holdPayouts = new Function("dir", "existsSync", "writeFileSync", "console", `${holdBody}\nreturn holdPayouts;`)(holdDir, existsSync, writeFileSync, console);
holdPayouts("Balance does not match this payout.");
const holdPath = join(holdDir, "PAYHOLD");
check("a hold verdict writes PAYHOLD", existsSync(holdPath) && readFileSync(holdPath, "utf8") === "Balance does not match this payout.\n");
const blocked = new Function("dir", "existsSync", "if (existsSync(`${dir}/PAYHOLD`)) return \"skip\"; return \"send\";")(holdDir, existsSync);
check("no payout is sent while PAYHOLD exists", runSrc.includes("if (existsSync(`${dir}/PAYHOLD`)) return \"skip\";")
  && runSrc.includes("sendOn && settled !== \"hold\"")
  && blocked === "skip");

console.log("pay ok");
