import { r8 } from "./money.mjs";

const BANNED = /floor|yield|\bapr\b|dividend|passive income|guaranteed|more rewards coming/i;

export function truncateWallet(wallet) {
  const text = String(wallet);
  if (text.length <= 14) return `${text.slice(0, 3)}…${text.slice(-2)}`;
  return `${text.slice(0, 10)}…${text.slice(-4)}`;
}

export function toPublic({ night, cleared }) {
  const body = {
    mode: "dry_run",
    night,
    status: cleared.status,
    clearingPrice: cleared.price == null ? null : r8(cleared.price),
    koreMatched: r8(cleared.koreMatched),
    ktaMatched: r8(cleared.ktaMatched),
    fillCount: cleared.fills.length,
    houseBuyKore: r8(cleared.houseBuyKore),
    houseSellKore: r8(cleared.houseSellKore),
    houseKta: r8(cleared.house.kta),
    houseKore: r8(cleared.house.kore),
    houseKorePct: r8(cleared.houseKorePct),
    feesToHouse: r8(cleared.feesToHouse),
    fills: cleared.fills.map((fill) => ({
      wallet: truncateWallet(fill.wallet),
      side: fill.side,
      amount: r8(fill.amount),
      fee: r8(fill.fee),
      confirmed: true,
    })),
  };
  const text = JSON.stringify(body);
  if (BANNED.test(text)) throw new Error("public copy refused");
  if (/keeta_[a-z0-9]{20,}/.test(text)) throw new Error("public wallet refused");
  return body;
}
