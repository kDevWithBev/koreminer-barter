import { BARTER_LIVE } from "./live.mjs";

export function houseLine(call, live = BARTER_LIVE) {
  const practice = live !== true || call?.mode === "dry_run";
  if (practice) return call?.houseKore === 0 ? "House is buying only tonight." : "";
  const held = `House holds ${call.houseKta} KTA and ${call.houseKore} KORE.`;
  if (call.houseKore === 0) return `${held} House is buying only tonight.`;
  return held;
}
