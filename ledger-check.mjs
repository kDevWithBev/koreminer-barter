import { DAY_MS, addDeposit, dayBudget, dayKey, dayStart, splitDay, startMs } from "./ledger.mjs";

function check(name, ok) {
  if (!ok) throw new Error(name);
  console.log("ok", name);
}

const endMs = Date.parse("2030-10-10T00:00:00Z");
let sum = 0n;
let days = 0;
for (let t = startMs; t < endMs; t += DAY_MS) {
  const budget = dayBudget(t + 3_600_000);
  sum += budget;
  if (budget > 0n) days += 1;
}
check("four years are 1461 paid days", days === 1461);
check("four years sum to 21 million", sum === 21_000_000n);
check("before open pays nothing", dayBudget(startMs - DAY_MS + 3_600_000) === 0n);
check("the day after the schedule pays nothing", dayBudget(endMs + 3_600_000) === 0n);
check("year one ordinary day is 30684", dayBudget(startMs + 3_600_000) === 30_684n);
check("the leap day is in year two", dayBudget(Date.parse("2028-02-29T12:00:00Z")) === 15_300n);
check("year two has 366 days", (Date.parse("2028-10-10T00:00:00Z") - Date.parse("2027-10-10T00:00:00Z")) / DAY_MS === 366);

const budget = 30_684n;
const split = splitDay(budget, new Map([["b", 10n], ["a", 100n]]));
check("larger deposit is paid first", split[0].from === "a" && split[0].share === 27_894n);
check("smaller deposit gets the rest", split[1].from === "b" && split[1].share === 2_790n);
check("shares add up to the day", split.reduce((total, row) => total + row.share, 0n) === budget);

const dust = splitDay(10n, new Map([["c", 1n], ["a", 1n], ["b", 1n]]));
check("equal deposits still add up", dust.reduce((total, row) => total + row.share, 0n) === 10n);
check("one miner gets the whole day", splitDay(budget, new Map([["a", 1n]]))[0].share === budget);

const intake = "intake";
const sink = "sink";
const miners = new Map();
check("a deposit counts", addDeposit(miners, "miner", 5n, { intake, sink }));
check("the shaft cannot pay itself", !addDeposit(miners, intake, 9n, { intake, sink }));
check("the dust sink cannot earn", !addDeposit(miners, sink, 9n, { intake, sink }));
check("only the miner is in the day", miners.size === 1 && miners.get("miner") === 5n);

const yesterday = dayStart(Date.now()) - DAY_MS;
check("a closed day has its own key", dayKey(yesterday) !== dayKey(yesterday + DAY_MS));
console.log("ledger ok");
