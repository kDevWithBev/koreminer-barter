import { median } from "./money.mjs";
import { intentOpen } from "./time.mjs";

function historyOf(input, wallet) {
  const row = input.history?.[wallet] ?? {};
  const skips = row.skips ?? 0;
  return {
    skips,
    lastBuyAt: row.lastBuyAt ?? "",
    half: skips > 1,
  };
}

export function prepareOrders(input) {
  const medianCost = median(input.costToMine ?? []);
  const sells = [];
  const buys = [];
  const rejected = [];
  for (const intent of input.intents ?? []) {
    if (!intentOpen(intent.submitted_at)) {
      rejected.push({ wallet: intent.wallet, reason: "window" });
      continue;
    }
    const past = historyOf(input, intent.wallet);
    if (intent.side === "keep") continue;
    const balance = input.balances?.[intent.wallet] ?? { kore: 0, kta: 0 };
    if (intent.side === "sell_half" || intent.side === "sell_all") {
      const cap = intent.side === "sell_all" ? balance.kore : balance.kore / 2;
      let qty = cap;
      if (Number.isFinite(intent.amount)) qty = Math.min(qty, intent.amount);
      qty = Math.max(0, qty);
      let limit = medianCost;
      if (Number.isFinite(intent.limit)) limit = Math.min(intent.limit, medianCost ?? intent.limit);
      if (!(qty > 0) || !(limit > 0)) {
        rejected.push({ wallet: intent.wallet, reason: "empty" });
        continue;
      }
      sells.push({
        wallet: intent.wallet,
        side: "sell",
        qty,
        limit,
        submitted_at: intent.submitted_at,
        ...past,
      });
      continue;
    }
    if (intent.side === "buy") {
      const qty = Math.max(0, intent.amount ?? 0);
      if (!(qty > 0)) {
        rejected.push({ wallet: intent.wallet, reason: "empty" });
        continue;
      }
      buys.push({
        wallet: intent.wallet,
        side: "buy",
        qty,
        limit: Number.isFinite(intent.limit) ? intent.limit : null,
        kta: Math.max(0, balance.kta ?? 0),
        submitted_at: intent.submitted_at,
        ...past,
      });
      continue;
    }
    rejected.push({ wallet: intent.wallet, reason: "side" });
  }
  return { medianCost, sells, buys, rejected };
}
