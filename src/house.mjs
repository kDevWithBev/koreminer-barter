export const HOUSE = {
  potKta: 100,
  nightCapKta: 5,
  nightCapMaxKta: 10,
  spread: 0.03,
  skew: 0.2,
  koreStop: 0.7,
  fee: 0.005,
  bartererFee: 0.0025,
};

// Disabled on purpose. Nothing is shared onward in this branch.
export const FEE_SHARE = { enabled: false, name: "fee-share-stub" };

export function assertHouse(cfg) {
  if (!(cfg.skew * 0.2 < 2 * (cfg.spread + cfg.fee))) {
    throw new Error("house quote refused");
  }
  if (!(cfg.nightCapKta >= 5 && cfg.nightCapKta <= cfg.nightCapMaxKta)) {
    throw new Error("night cap refused");
  }
}

export function referencePrice(lastClear, medianCost) {
  if (Number.isFinite(lastClear) && lastClear > 0) return lastClear;
  if (Number.isFinite(medianCost) && medianCost > 0) return medianCost;
  return null;
}
export function quote(cfg, state, mid) {
  if (!(mid > 0)) {
    return {
      reference: null,
      center: null,
      bid: null,
      ask: null,
      korePct: 0,
      mayBuy: false,
      maySell: false,
      quoted: false,
    };
  }
  const koreValue = state.kore * mid;
  const total = koreValue + state.kta;
  const korePct = total > 0 ? koreValue / total : 0;
  const shift = cfg.skew * (korePct - 0.5);
  const center = mid * (1 - shift);
  const half = cfg.spread / 2;
  const mayBuy = state.kta > 0 && korePct <= cfg.koreStop;
  const maySell = state.kore > 0;
  return {
    reference: mid,
    center,
    bid: mayBuy ? center * (1 - half) : null,
    ask: maySell ? center * (1 + half) : null,
    korePct,
    mayBuy,
    maySell,
    quoted: mayBuy || maySell,
  };
}
