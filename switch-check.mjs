import { readFileSync } from "node:fs";
import { BLOCK_FEE, DAY_MS, RESERVE, fromKta, pace } from "./pace.mjs";

const run = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
const sink = "keeta_aabe7jhqj3bzv3jg3l6el5myl24yvjawy73btyurwdv5kyhpsmv7a2yec4ep4sq";
const oldSink = "keeta_aabos2wqagrumwmhwolavouvojebefv5ilei3rt5gmakjkukxq23zxujjtxhdwq";

function check(name, ok) {
  if (!ok) throw new Error(name);
  console.log("ok", name);
}

check("provable sink is fixed", run.includes(sink));
check("old sink is gone", !run.includes(oldSink));
check("no random key is created", !run.includes("generateRandomSeed"));
check("the 30 KTA cap is gone", !run.includes("spendCap"));
const sends = run.match(/builder\.send\([^)]+\)/g) || [];
check("dust sends stay", sends.some((line) => line.includes("1n, base")));
check("KORE send pays the planned amount", sends.some((line) => line.includes("row.amount, koreAccount")));
check("KORE is only watched", run.includes("client.balance(kore)"));
check("a KORE drop without a floor holds payouts", run.includes('holdPayouts("KORE moved without a matching payout.")'));
check("reserve is kept", run.includes("wallet < BLOCK_FEE + RESERVE"));

let balance = fromKta("13");
while (true) {
  const plan = pace({ balance, remainingMs: DAY_MS });
  if (plan.tpsMilli === 0n || balance < BLOCK_FEE + RESERVE) break;
  balance -= BLOCK_FEE;
}
check("13 KTA of fuel never spends the reserve", balance >= RESERVE);

const empty = fromKta("0");
const stopped = pace({ balance: empty, remainingMs: DAY_MS });
check("an empty shaft does not start", stopped.tpsMilli === 0n);

const fresh = pace({ balance: fromKta("30"), remainingMs: DAY_MS });
check("a new day at 30 KTA is about 2.89/s", fresh.tpsMilli >= 2800n && fresh.tpsMilli <= 3000n);
console.log("reserve left", balance.toString());
