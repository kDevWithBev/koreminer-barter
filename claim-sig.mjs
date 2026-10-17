import { secp256k1 } from "ethereum-cryptography/secp256k1.js";
import { keccak256 } from "ethereum-cryptography/keccak.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "ethereum-cryptography/utils.js";

const MAGIC = "1626ba7e";

function hashMessage(message) {
  const body = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${body.length}`);
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
  const hex = String(signature).startsWith("0x") ? String(signature).slice(2) : String(signature);
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return "";
  const bytes = hexToBytes(hex);
  let bit = bytes[64];
  if (bit >= 27) bit -= 27;
  if (bit !== 0 && bit !== 1) return "";
  try {
    const sig = secp256k1.Signature.fromCompact(bytesToHex(bytes.slice(0, 64))).addRecoveryBit(bit);
    return addressOf(sig.recoverPublicKey(hashMessage(message)));
  } catch {
    return "";
  }
}

export function contractCall(hash, signature) {
  const sig = hexToBytes(String(signature).startsWith("0x") ? String(signature).slice(2) : String(signature));
  const words = new Uint8Array(4 + 32 + 32 + 32 + 32 * Math.ceil(sig.length / 32));
  words.set(hexToBytes(MAGIC), 0);
  words.set(hash, 4);
  words[4 + 63] = 64;
  words[4 + 64 + 31] = sig.length;
  words.set(sig, 4 + 96);
  return `0x${bytesToHex(words)}`;
}

export async function signatureOwns({ message, signature, base, call }) {
  if (recoverAddress(message, signature).toLowerCase() === base.toLowerCase()) return true;
  if (typeof call !== "function") return false;
  const data = contractCall(hashMessage(message), signature);
  const result = await call(base, data);
  return typeof result === "string" && result.toLowerCase().startsWith(`0x${MAGIC}`);
}
