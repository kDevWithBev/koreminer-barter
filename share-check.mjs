import { dayBudget, startMs } from "./ledger.mjs";
import { RESERVE, accrue, burn, createShare, deposit, due, lookup, markPaid, whole } from "./share.mjs";

const DAY = 86_400_000;
const open = startMs;
const kta = (n) => BigInt(n) * 10n ** 18n;

function check(name, ok) {
  if (!ok) throw new Error(name);
  console.log("ok", name);
}

function opened() {
  const state = createShare(open);
  deposit(state, "reserve", kta(2), open);
  return state;
}

const budget = dayBudget(open + 3_600_000);
check("opening day pays 30684", budget === 30_684n);

const state = opened();
check("reserve is full", state.reserve === RESERVE);
deposit(state, "alice", kta(10), open);
deposit(state, "bob", kta(30), open);
accrue(state, open + DAY);
const alice = lookup(state, "alice");
const bob = lookup(state, "bob");
check("alice gets a quarter", whole(alice.counted) === 7_671n);
check("bob gets three quarters", whole(bob.counted) === 23_013n);
check("the day adds up", whole(alice.counted + bob.counted) === budget);
check("both have a one-day streak", alice.streak === 1 && bob.streak === 1);

const late = opened();
deposit(late, "alice", kta(10), open);
deposit(late, "bob", kta(10), open + DAY / 2);
accrue(late, open + DAY);
check("a noon deposit earns half a day", whole(lookup(late, "bob").counted) === 7_671n);
check("the early deposit earns the rest", whole(lookup(late, "alice").counted) === 23_013n);

const again = opened();
deposit(again, "alice", kta(10), open);
deposit(again, "alice", kta(10), open + DAY / 2);
accrue(again, open + DAY);
check("a second send is added", lookup(again, "alice").fuel === kta(20));
check("the same address still gets the whole day", whole(lookup(again, "alice").counted) === budget);

const quiet = createShare(open);
accrue(quiet, open + DAY);
check("an empty day assigns nothing", quiet.pending.size === 0);

const used = opened();
deposit(used, "alice", kta(10), open);
const unburned = burn(used, kta(4), open + DAY / 2);
accrue(used, open + DAY);
check("the burn came out of her fuel", unburned === 0n);
check("depth is the burned KTA", lookup(used, "alice").depth === kta(4));
check("fuel left is still earning", lookup(used, "alice").fuel === kta(6));
check("she keeps the whole day while alone", whole(lookup(used, "alice").counted) === budget);

const dust = opened();
deposit(dust, "ant", kta(1), open);
deposit(dust, "whale", kta(1_000_000), open);
accrue(dust, open + 60_000);
check("a minute is under 1 KORE", due(dust, "ant") === 0n);
check("the fraction is still counted", lookup(dust, "ant").counted > 0n);

const pay = opened();
deposit(pay, "alice", kta(10), open);
accrue(pay, open + DAY);
const owed = due(pay, "alice");
markPaid(pay, "alice", owed);
check("a payout clears what is due", due(pay, "alice") === 0n);
check("paid is the whole day", lookup(pay, "alice").paid === budget);
check("paying twice is refused", (() => { try { markPaid(pay, "alice", 1n); return false; } catch { return true; } })());

const before = createShare(open - DAY);
deposit(before, "alice", kta(10), open - DAY);
accrue(before, open);
check("before open pays nothing", lookup(before, "alice").counted === 0n);

const missed = opened();
deposit(missed, "alice", kta(10), open);
accrue(missed, open + DAY);
burn(missed, kta(10), open + DAY);
accrue(missed, open + DAY * 2);
check("a day with no fuel breaks the streak", lookup(missed, "alice").streak === 0);

const BRIDGE = "keeta_aqltdal4rshtky5iehd765y3mdjkcmku5d4ulo5fgonzqrxulwepnogq33mle";
const held = opened();
deposit(held, "keeta_alice", kta(30), open);
deposit(held, BRIDGE, kta(10), open);
accrue(held, open + DAY);
const heldBridge = lookup(held, BRIDGE);
const heldAlice = lookup(held, "keeta_alice");
check("a bridge with fuel earns its fraction", whole(heldBridge.counted) === 7_671n);
check("that fraction is waiting", heldBridge.waiting === heldBridge.counted && heldBridge.waiting > 0n);
check("the keeta miner keeps the rest", whole(heldAlice.counted) === 23_013n);
let heldSum = 0n;
for (const amount of held.pending.values()) heldSum += amount;
check("the day still adds up with the bridge included", whole(heldSum) === budget);

const idle = opened();
deposit(idle, "keeta_alice", kta(10), open);
idle.stake.set(BRIDGE, 0n);
accrue(idle, open + DAY);
check("a bridge with no fuel earns nothing", (idle.pending.get(BRIDGE) ?? 0n) === 0n);
check("a miner beside an empty bridge still gets the day", whole(lookup(idle, "keeta_alice").counted) === budget);

console.log("share ok");
