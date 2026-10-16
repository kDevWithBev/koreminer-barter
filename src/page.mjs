export function houseLine(call) {
  const held = `House holds ${call.houseKta} KTA and ${call.houseKore} KORE.`;
  if (call.houseKore === 0) return `${held} House is buying only tonight.`;
  return held;
}
