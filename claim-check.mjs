import { createShare, deposit } from "./share.mjs";
import { BRIDGE, KNOWN_BASE, checkClaim, claimMessage, isBaseAddress, isKeetaAddress, reassign } from "./claim.mjs";

const kta = (n) => BigInt(n) * 10n ** 18n;
function check(name, ok) {
  if (!ok) throw new Error(name);
  console.log("ok", name);
}

check("the known base address is 42 characters", KNOWN_BASE.length === 42 && isBaseAddress(KNOWN_BASE));
check("a short base address is rejected", !isBaseAddress("0x" + "ab".repeat(19)));
check("a long base address is rejected", !isBaseAddress(`${KNOWN_BASE}a`));
check("a keeta address is not a base address", !isBaseAddress(BRIDGE));
check("the bridge address is a keeta address", isKeetaAddress(BRIDGE));

const good = checkClaim({
  base: KNOWN_BASE.toUpperCase().replace("0X", "0x"),
  keeta: "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i",
  nonce: "nonce-1234567890abcd",
  date: "2026-10-13",
}, Date.parse("2026-10-13T12:00:00Z"));
check("a real claim shape is accepted", good.ok === true);
check("the message uses the lowercase base address", good.message === claimMessage({
  base: KNOWN_BASE,
  keeta: "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i",
  nonce: "nonce-1234567890abcd",
  date: "2026-10-13",
}));
check("another base address has no credit", checkClaim({
  base: "0x" + "11".repeat(20),
  keeta: "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i",
  nonce: "nonce-1234567890abcd",
  date: "2026-10-13",
}, Date.parse("2026-10-13T12:00:00Z")).reason === "no-credit");
check("a keeta address cannot be claimed as base", checkClaim({
  base: BRIDGE,
  keeta: "keeta_aabik63e6x7svkclg74scrqe373rhy5v4xtbp7lx7wcbkrdk2evpiqcl3cihd2i",
  nonce: "nonce-1234567890abcd",
  date: "2026-10-13",
}).reason === "bad-base");

const share = createShare(0);
deposit(share, "keeta_alice", kta(10), 0);
deposit(share, BRIDGE, 23348300571823728000n, 0);
deposit(share, "keeta_bob", kta(5), 0);
const before = [...share.stake.values()].reduce((sum, n) => sum + n, 0n);
const alice = share.stake.get("keeta_alice");
const bob = share.stake.get("keeta_bob");
check("the bridge lot moves to the signed keeta address", reassign(share, good.keeta) === "moved");
check("the bridge no longer has fuel", (share.stake.get(BRIDGE) ?? 0n) === 0n);
check("the claimant has the bridge fuel", share.stake.get(good.keeta) === 23348300571823728000n);
check("other miners are unchanged", share.stake.get("keeta_alice") === alice && share.stake.get("keeta_bob") === bob);
check("the total fuel did not change", [...share.stake.values()].reduce((sum, n) => sum + n, 0n) === before);
check("moving twice finds nothing", reassign(share, good.keeta) === "none");

const split = createShare(0);
split.reserve = 2n * 10n ** 18n;
deposit(split, BRIDGE, 1000n, 0);
deposit(split, BRIDGE, 1000n, 0);
check("two bridge lots are not moved", reassign(split, good.keeta) === "split");
check("a split leaves the bridge in place", split.lots.every((lot) => lot.from === BRIDGE));
console.log("claim ok");
