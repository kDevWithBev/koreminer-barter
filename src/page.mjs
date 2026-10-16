import { BARTER_LIVE } from "./live.mjs";

export function streakLines(row) {
  const mining = Number(row?.miningStreak) || 0;
  const ladder = Number(row?.ladderStreak ?? row?.streak) || 0;
  const used = Number(row?.shieldsUsed) || 0;
  const shield = used === 1 ? "1 shield used" : `${used} shields used`;
  return {
    mining: `Mining streak ${mining}`,
    ladder: `Ladder streak ${ladder} (${shield})`,
  };
}

export function houseLine(call, live = BARTER_LIVE) {
  const practice = live !== true || call?.mode === "dry_run";
  if (practice) return call?.houseKore === 0 ? "House is buying only tonight." : "";
  const held = `House holds ${call.houseKta} KTA and ${call.houseKore} KORE.`;
  if (call.houseKore === 0) return `${held} House is buying only tonight.`;
  return held;
}
