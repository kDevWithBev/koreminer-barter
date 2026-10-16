import { eligibility } from "./eligibility.mjs";
import { clearNight } from "./clear.mjs";
import { HOUSE, FEE_SHARE, assertHouse, quote, referencePrice } from "./house.mjs";
import { prepareOrders } from "./intents.mjs";
import { BARTER_LIVE } from "./live.mjs";
import { toPublic } from "./publish.mjs";

export function runCall(input) {
  if (BARTER_LIVE) throw new Error("live path is off");
  const cfg = {
    ...HOUSE,
    nightCapKta: input.house?.nightCapKta ?? HOUSE.nightCapKta,
    ...(input.houseConfig ?? {}),
  };
  assertHouse(cfg);
  const prepared = prepareOrders(input);
  const state = { kta: input.house.kta, kore: input.house.kore };
  const reference = referencePrice(input.lastClear, prepared.medianCost);
  const quoted = quote(cfg, state, reference);
  const cleared = clearNight({
    sells: prepared.sells,
    buys: prepared.buys,
    quoted,
    cfg,
    house: state,
    confirms: input.confirms ?? null,
    barterers: new Set(input.barterers ?? []),
  });
  const weights = eligibility(input);
  return {
    publicCall: toPublic({ night: input.night, cleared }),
    server: {
      rejected: prepared.rejected,
      adjustments: prepared.adjustments,
      skips: cleared.skips,
      eligibility: weights,
      flags: input.cluster ?? {},
      quote: quoted,
      medianCost: prepared.medianCost,
      feeShare: FEE_SHARE.enabled,
      orders: { sells: prepared.sells, buys: prepared.buys },
    },
  };
}
