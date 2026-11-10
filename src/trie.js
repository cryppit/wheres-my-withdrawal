// A read-only Merkle-Patricia proof verifier: just enough to re-fold an eth_getProof account/storage proof to its root,
// so a Taiko signal proof is trusted only after it folds to the state root TaikoInbox synced to L1. This mirrors, in
// the browser, what the on-chain LibTrieProof (and Optimism's SecureMerkleTrie it is built on) does: walk the RLP
// nodes from the root, follow the keccak256(key) path, and confirm each node hashes to the reference its parent held.
// Pure: no clock, no network. Verified against a real Taiko signal proof on 10 Nov 2026 (see test/taiko.test.js).
import { keccakHex } from "./abi.js";

const strip = (h) => h.replace(/^0x/, "").toLowerCase();
const bytesLen = (h) => strip(h).length / 2;

/** The nibbles (4-bit halves) of a hex byte string. */
function nibbles(hexStr) {
  const s = strip(hexStr);
  const out = [];
  for (let i = 0; i < s.length; i++) out.push(parseInt(s[i], 16));
  return out;
}

/** A hex-path (leaf/extension) node's compact header: whether it is a leaf, and the path nibbles it covers. */
function compact(hexStr) {
  const nib = nibbles(hexStr);
  const flag = nib[0];
  return { leaf: flag >= 2, path: flag % 2 === 1 ? nib.slice(1) : nib.slice(2) };
}

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Minimal RLP decoder. A byte string decodes to its hex ("0x…"); a list decodes to an array of its decoded items.
 * Enough for trie nodes (lists of 2 or 17) and account/value payloads.
 */
export function rlpDecode(hexStr) {
  const s = strip(hexStr);
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  const [item] = decode(b, 0);
  return item;
}

function decode(b, pos) {
  const p = b[pos];
  const asHex = (from, len) => "0x" + [...b.slice(from, from + len)].map((x) => x.toString(16).padStart(2, "0")).join("");
  if (p < 0x80) return [asHex(pos, 1), pos + 1];
  if (p < 0xb8) {
    const len = p - 0x80;
    return [asHex(pos + 1, len), pos + 1 + len];
  }
  if (p < 0xc0) {
    const ll = p - 0xb7;
    const len = toInt(b, pos + 1, ll);
    const start = pos + 1 + ll;
    return [asHex(start, len), start + len];
  }
  const header = p < 0xf8 ? 1 : 1 + (p - 0xf7);
  const len = p < 0xf8 ? p - 0xc0 : toInt(b, pos + 1, p - 0xf7);
  const end = pos + header + len;
  const out = [];
  let i = pos + header;
  while (i < end) {
    const [it, next] = decode(b, i);
    out.push(it);
    i = next;
  }
  return [out, end];
}

function toInt(b, pos, len) {
  let n = 0;
  for (let i = 0; i < len; i++) n = n * 256 + b[pos + i];
  return n;
}

/** If `hex` RLP-encodes a list, its items (each as encoded-bytes hex); otherwise false. */
export function rlpList(hex) {
  const d = rlpDecode(hex);
  return Array.isArray(d) ? d : false;
}

/** The payload bytes of an RLP byte-string item (e.g. a storage slot's stored value). */
export function rlpBytes(hex) {
  const d = rlpDecode(hex);
  return Array.isArray(d) ? "0x" : d;
}

/**
 * Verify an inclusion Merkle-Patricia proof. `root` is the 32-byte root the proof must fold to; `key` is the raw key
 * (an address or a storage slot, hashed with keccak256 for the secure trie); `proofNodes` are the RLP node hex strings
 * from eth_getProof, root-first. Returns { ok, value } where `value` is the leaf's stored value (RLP bytes hex) when
 * the path reaches it, or { ok: false } when a node does not hash to its reference or the path does not lead to a leaf.
 */
export function verifyMerkleProof(root, key, proofNodes) {
  if (!Array.isArray(proofNodes) || !proofNodes.length) return { ok: false };
  const path = nibbles(keccakHex(key));
  let pos = 0;
  let idx = 0;
  let node = proofNodes[0];
  if (strip(keccakHex(node)) !== strip(root)) return { ok: false };
  let dec = rlpDecode(node);

  for (let guard = 0; guard < proofNodes.length + 2; guard++) {
    if (!Array.isArray(dec)) return { ok: false };
    let child;
    if (dec.length === 17) {
      if (pos === path.length) return { ok: true, value: dec[16] };
      child = dec[path[pos]];
      pos += 1;
    } else if (dec.length === 2) {
      const { leaf, path: seg } = compact(dec[0]);
      const rem = path.slice(pos);
      if (leaf) return eq(rem, seg) ? { ok: true, value: dec[1] } : { ok: false };
      if (!eq(rem.slice(0, seg.length), seg)) return { ok: false };
      pos += seg.length;
      child = dec[1];
    } else {
      return { ok: false };
    }
    if (Array.isArray(child)) {
      dec = child; // an embedded (inline) node: no hash reference, process directly
      continue;
    }
    if (typeof child !== "string" || bytesLen(child) === 0) return { ok: false };
    // A 32-byte hash reference: the next proof node must hash to it.
    idx += 1;
    node = proofNodes[idx];
    if (!node || strip(keccakHex(node)) !== strip(child)) return { ok: false };
    dec = rlpDecode(node);
  }
  return { ok: false };
}
