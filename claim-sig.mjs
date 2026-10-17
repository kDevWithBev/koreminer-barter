import { keccak256, bytesToHex, hexToBytes } from "./keccak.mjs";

const MAGIC_1271 = "1626ba7e";
const MAGIC_6492 = "6492649264926492649264926492649264926492649264926492649264926492";
export const VALIDATOR = "0x7dd271fa79df3a5feb99f73bebfa4395b2e4f4be";

const encoder = new TextEncoder();
const VALIDATOR_SELECTOR = bytesToHex(keccak256(encoder.encode("isValidSig(address,bytes32,bytes)"))).slice(0, 8);

let secp = null;
try {
  const mod = await import("ethereum-cryptography/secp256k1.js");
  secp = mod.secp256k1;
} catch {
  secp = null;
}

export function hashMessage(message) {
  const body = encoder.encode(message);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const joined = new Uint8Array(prefix.length + body.length);
  joined.set(prefix, 0);
  joined.set(body, prefix.length);
  return keccak256(joined);
}

function addressOf(publicKey) {
  const raw = publicKey.toRawBytes(false);
  return `0x${bytesToHex(keccak256(raw.slice(1)).slice(-20))}`;
}

export function recoverAddress(message, signature) {
  if (!secp) return "";
  const hex = String(signature).startsWith("0x") ? String(signature).slice(2) : String(signature);
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return "";
  const bytes = hexToBytes(hex);
  let bit = bytes[64];
  if (bit >= 27) bit -= 27;
  if (bit !== 0 && bit !== 1) return "";
  try {
    const sig = secp.Signature.fromCompact(bytesToHex(bytes.slice(0, 64))).addRecoveryBit(bit);
    return addressOf(sig.recoverPublicKey(hashMessage(message)));
  } catch {
    return "";
  }
}

export function contractCall(hash, signature) {
  const sig = hexToBytes(String(signature).startsWith("0x") ? String(signature).slice(2) : String(signature));
  if (!sig) return "0x";
  const words = new Uint8Array(4 + 32 + 32 + 32 + 32 * Math.ceil(sig.length / 32));
  words.set(hexToBytes(MAGIC_1271), 0);
  words.set(hash, 4);
  words[4 + 63] = 64;
  words[4 + 64 + 31] = sig.length;
  words.set(sig, 4 + 96);
  return `0x${bytesToHex(words)}`;
}

export function isErc6492(signature) {
  const hex = String(signature).startsWith("0x") ? String(signature).slice(2) : String(signature);
  return hex.toLowerCase().endsWith(MAGIC_6492) && hex.length > MAGIC_6492.length;
}

export function validatorCall(base, hash, signature) {
  const sig = hexToBytes(String(signature).startsWith("0x") ? String(signature).slice(2) : String(signature));
  if (!sig) return "0x";
  const addr = String(base).toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const head = new Uint8Array(4 + 96);
  head.set(hexToBytes(VALIDATOR_SELECTOR), 0);
  head.set(hexToBytes(addr), 4);
  head.set(hash, 36);
  const offset = hexToBytes("60".padStart(64, "0"));
  head.set(offset, 68);
  const tail = new Uint8Array(32 + 32 * Math.ceil(sig.length / 32));
  const len = sig.length;
  tail[28] = (len >>> 24) & 255;
  tail[29] = (len >>> 16) & 255;
  tail[30] = (len >>> 8) & 255;
  tail[31] = len & 255;
  tail.set(sig, 32);
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return `0x${bytesToHex(out)}`;
}

function accepted(result) {
  if (typeof result !== "string" || !result.startsWith("0x")) return false;
  const hex = result.slice(2).toLowerCase();
  if (hex.startsWith(MAGIC_1271)) return true;
  try { return hex.length > 0 && BigInt(`0x${hex}`) === 1n; } catch { return false; }
}

export async function signatureOwns({ message, signature, base, call, recover }) {
  const hash = hashMessage(message);
  if (isErc6492(signature)) {
    if (typeof call !== "function") return false;
    return accepted(await call(VALIDATOR, validatorCall(base, hash, signature)));
  }
  const rec = typeof recover === "function" ? recover : recoverAddress;
  if (rec(message, signature).toLowerCase() === String(base).toLowerCase()) return true;
  if (typeof call !== "function") return false;
  const direct = await call(base, contractCall(hash, signature));
  if (typeof direct === "string" && direct.toLowerCase().startsWith(`0x${MAGIC_1271}`)) return true;
  if (typeof recover === "function") return false;
  return accepted(await call(VALIDATOR, validatorCall(base, hash, signature)));
}
