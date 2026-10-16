import { r8 } from "./money.mjs";

function byPriority(a, b) {
  if (a.half !== b.half) return a.half ? 1 : -1;
  if (a.lastBuyAt !== b.lastBuyAt) return a.lastBuyAt < b.lastBuyAt ? 1 : -1;
  if (a.wallet < b.wallet) return -1;
  if (a.wallet > b.wallet) return 1;
  return 0;
}

function feeRate(wallet, cfg, barterers) {
  return barterers.has(wallet) ? cfg.bartererFee : cfg.fee;
}

function afford(kta, price, rate) {
  const unit = price * (1 + rate);
  if (!(unit > 0)) return 0;
  return kta / unit;
}

export function clearingPrice({ sells, buys, quoted, cfg, barterers }) {
  const settersS = sells.filter((order) => !order.half);
  const settersB = buys.filter((order) => !order.half);
  const prices = new Set([quoted.center]);
  for (const order of [...settersS, ...settersB]) {
    if (Number.isFinite(order.limit)) prices.add(order.limit);
  }
  let best = null;
  for (const price of prices) {
    if (!(price > 0)) continue;
    let supply = 0;
    for (const order of settersS) if (order.limit <= price + 1e-12) supply += order.qty;
    let demand = 0;
    for (const order of settersB) {
      const limit = order.limit == null ? quoted.ask : order.limit;
      if (limit + 1e-12 < price) continue;
      demand += Math.min(order.qty, afford(order.kta, price, feeRate(order.wallet, cfg, barterers)));
    }
    const matched = Math.min(supply, demand);
    if (!(matched > 1e-12)) continue;
    const distance = Math.abs(price - quoted.center);
    if (
      !best ||
      matched > best.matched + 1e-12 ||
      (Math.abs(matched - best.matched) <= 1e-12 && distance < best.distance - 1e-12) ||
      (Math.abs(matched - best.matched) <= 1e-12 && Math.abs(distance - best.distance) <= 1e-12 && price < best.price)
    ) {
      best = { price, matched, distance };
    }
  }
  return best ? best.price : null;
}

function matchAt(sells, buys, price, cfg, barterers) {
  const leftS = sells
    .filter((order) => order.limit <= price + 1e-12)
    .map((order) => ({ ...order, left: order.qty }))
    .sort(byPriority);
  const leftB = buys
    .filter((order) => {
      const limit = order.limit == null ? Number.POSITIVE_INFINITY : order.limit;
      return limit + 1e-12 >= price;
    })
    .map((order) => ({ ...order, left: order.qty, cash: order.kta }))
    .sort(byPriority);
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < leftS.length && j < leftB.length) {
    const sell = leftS[i];
    const buy = leftB[j];
    if (sell.left <= 1e-12) {
      i += 1;
      continue;
    }
    if (buy.left <= 1e-12) {
      j += 1;
      continue;
    }
    const buyRate = feeRate(buy.wallet, cfg, barterers);
    const qty = Math.min(sell.left, buy.left, afford(buy.cash, price, buyRate));
    if (qty <= 1e-12) {
      j += 1;
      continue;
    }
    const notional = qty * price;
    buy.cash -= notional * (1 + buyRate);
    sell.left -= qty;
    buy.left -= qty;
    pairs.push({
      sell: sell.wallet,
      buy: buy.wallet,
      qty,
      price,
      sellFee: notional * feeRate(sell.wallet, cfg, barterers),
      buyFee: notional * buyRate,
    });
  }
  return pairs;
}

function isConfirmed(wallet, confirms) {
  if (!confirms) return true;
  return confirms[wallet] === "confirmed";
}

function houseTake(side, qty, price, quoted, house, cfg, spent) {
  if (!(qty > 0) || !(price > 0)) return 0;
  const room = cfg.nightCapKta - spent;
  if (!(room > 1e-12)) return 0;
  if (side === "buy") {
    if (!quoted.mayBuy) return 0;
    if (price > quoted.bid + 1e-12) return 0;
    const cash = Math.min(room, house.kta, cfg.potKta);
    return Math.min(qty, cash / price);
  }
  if (price + 1e-12 < quoted.ask) return 0;
  return Math.min(qty, house.kore, room / price);
}

export function clearNight({ sells, buys, quoted, cfg, house, confirms, barterers }) {
  const withBuyLimits = buys.map((order) => ({
    ...order,
    limit: order.limit == null ? quoted.ask : order.limit,
  }));
  const price = clearingPrice({ sells, buys: withBuyLimits, quoted, cfg, barterers });
  const skips = [];
  if (confirms) {
    for (const [wallet, choice] of Object.entries(confirms)) {
      if (choice === "skipped") skips.push(wallet);
    }
  }
  if (price == null) {
    return {
      status: "no_clear",
      price: null,
      fills: [],
      house: { ...house },
      houseBuyKore: 0,
      houseSellKore: 0,
      houseKorePct: quoted.korePct,
      feesToHouse: 0,
      koreMatched: 0,
      ktaMatched: 0,
      skips,
    };
  }

  const pairs = matchAt(sells, withBuyLimits, price, cfg, barterers).filter(
    (pair) => isConfirmed(pair.sell, confirms) && isConfirmed(pair.buy, confirms),
  );

  const sellLeft = new Map(
    sells
      .filter((order) => isConfirmed(order.wallet, confirms) && order.limit <= price + 1e-12)
      .map((order) => [order.wallet, order.qty]),
  );
  const buyLeft = new Map(
    withBuyLimits
      .filter((order) => isConfirmed(order.wallet, confirms) && order.limit + 1e-12 >= price)
      .map((order) => [order.wallet, order.qty]),
  );
  for (const pair of pairs) {
    sellLeft.set(pair.sell, (sellLeft.get(pair.sell) ?? 0) - pair.qty);
    buyLeft.set(pair.buy, (buyLeft.get(pair.buy) ?? 0) - pair.qty);
  }
  let leftoverSell = 0;
  for (const qty of sellLeft.values()) leftoverSell += Math.max(0, qty);
  let leftoverBuy = 0;
  for (const qty of buyLeft.values()) leftoverBuy += Math.max(0, qty);

  const next = { kta: house.kta, kore: house.kore };
  let spent = 0;
  let houseBuy = houseTake("buy", leftoverSell, price, quoted, next, cfg, spent);
  houseBuy = r8(houseBuy);
  const buyNotional = houseBuy * price;
  next.kore += houseBuy;
  next.kta -= buyNotional;
  spent += buyNotional;
  let houseSell = houseTake("sell", leftoverBuy, price, quoted, next, cfg, spent);
  houseSell = r8(houseSell);
  const sellNotional = houseSell * price;
  next.kore -= houseSell;
  next.kta += sellNotional;

  const fills = [];
  let fees = 0;
  for (const pair of pairs) {
    fills.push({ wallet: pair.sell, side: "sell", amount: pair.qty, fee: pair.sellFee });
    fills.push({ wallet: pair.buy, side: "buy", amount: pair.qty, fee: pair.buyFee });
    fees += pair.sellFee + pair.buyFee;
    next.kta += pair.sellFee + pair.buyFee;
  }
  if (houseBuy > 0) {
    const fee = buyNotional * cfg.fee;
    fills.push({ wallet: "house", side: "buy", amount: houseBuy, fee });
    fees += fee;
  }
  if (houseSell > 0) {
    const fee = sellNotional * cfg.fee;
    fills.push({ wallet: "house", side: "sell", amount: houseSell, fee });
    fees += fee;
  }

  let koreMatched = houseBuy + houseSell;
  for (const pair of pairs) koreMatched += pair.qty;
  const value = next.kore * price;
  const korePct = value + next.kta > 0 ? value / (value + next.kta) : 0;

  return {
    status: koreMatched > 1e-12 ? "clear" : "no_clear",
    price,
    fills,
    house: next,
    houseBuyKore: houseBuy,
    houseSellKore: houseSell,
    houseKorePct: korePct,
    feesToHouse: fees,
    koreMatched,
    ktaMatched: koreMatched * price,
    skips,
  };
}
