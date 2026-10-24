// The little ABI this tool needs: static arguments in, 32-byte words and dynamic bytes out.
import { keccak256, keccakText } from "./keccak.js";

export const selector = (signature) => keccakText(signature).slice(0, 10);
export const topic = (signature) => keccakText(signature);

const strip = (hex) => (hex.startsWith("0x") ? hex.slice(2) : hex);

export function fromHex(hex) {
  const h = strip(hex);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export const keccakHex = (hex) => keccak256(fromHex(hex));

/** One 32-byte word (64 hex chars, no 0x) for a bigint, number, address or bytes32. */
export function word(v) {
  if (typeof v === "bigint" || typeof v === "number") return BigInt(v).toString(16).padStart(64, "0");
  return strip(v).toLowerCase().padStart(64, "0");
}

/** Calldata for a function whose arguments are all static (bytes32, address, uint). */
export function encodeCall(signature, args = []) {
  return selector(signature) + args.map(word).join("");
}

export const decodeWords = (hex) => strip(hex).match(/.{64}/g) ?? [];
export const wordAt = (hex, i) => decodeWords(hex)[i];
export const uintAt = (hex, i) => BigInt("0x" + wordAt(hex, i));
export const toAddress = (w) => "0x" + strip(w).slice(-40).toLowerCase();
export const addressAt = (hex, i) => toAddress(wordAt(hex, i));
export const boolAt = (hex, i) => uintAt(hex, i) !== 0n;

/** The dynamic `bytes` whose offset sits in word `i` of `hex` (offsets count from the start of `hex`). */
export function decodeBytes(hex, i) {
  const h = strip(hex);
  const offset = Number(BigInt("0x" + h.slice(64 * i, 64 * i + 64))) * 2;
  const length = Number(BigInt("0x" + h.slice(offset, offset + 64))) * 2;
  return "0x" + h.slice(offset + 64, offset + 64 + length);
}

export const sameAddress = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** An ABI-encoded `string` return value, or null if it is not one (some old tokens return bytes32). */
export function decodeString(hex) {
  try {
    const raw = decodeBytes(hex, 0).slice(2);
    return new TextDecoder().decode(Uint8Array.from(raw.match(/.{2}/g) ?? [], (b) => parseInt(b, 16)));
  } catch {
    return null;
  }
}
