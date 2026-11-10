// The claim step on Arbitrum One, Robinhood Chain, Linea and Scroll, built from what the check already read: the exact
// call, rehearsed with eth_call. Read-only: nothing is signed or sent; whoever sends the call pays only the gas, and
// the funds still go only to the withdrawal's recipient.
import { selector } from "./abi.js";
import { check, clientsFor } from "./check.js";
import { rehearse } from "./prove.js";

const strip = (h) => h.replace(/^0x/, "");
const pad = (h) => strip(h).toLowerCase().padStart(64, "0");
const uint = (v) => BigInt(v).toString(16).padStart(64, "0");
const bytesTail = (hex) => {
  const h = strip(hex).toLowerCase();
  return uint(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, "0");
};
const words = (items) => uint(items.length) + items.map(pad).join("");
const NO_FEE_RECIPIENT = "0x" + "0".repeat(40); // Linea pays the message fee to whoever sends the claim

/** Outbox.executeTransaction(proof, index, l2Sender, to, l2Block, l1Block, l2Timestamp, value, data) (nitro-contracts AbsOutbox). */
export function encodeArbitrumClaim(hashes, w) {
  const proof = words(hashes);
  const head = 9 * 32;
  return (
    selector("executeTransaction(bytes32[],uint256,address,address,uint256,uint256,uint256,uint256,bytes)") +
    uint(head) + uint(w.position) + pad(w.sender) + pad(w.target) + uint(w.arbBlockNum) + uint(w.ethBlockNum) + uint(w.timestamp) + uint(w.value) +
    uint(head + proof.length / 2) + proof + bytesTail(w.data)
  );
}

/** LineaRollup.claimMessageWithProof(ClaimMessageWithProofParams) (linea-monorepo IL1MessageService). */
export function encodeLineaClaim(proof, w) {
  const hashes = words(proof.hashes);
  const head = 10 * 32;
  const tuple =
    uint(head) + uint(w.nonce) + uint(proof.leafIndex) + pad(w.from) + pad(w.to) + uint(w.fee) + uint(w.value) + pad(NO_FEE_RECIPIENT) + pad(proof.root) +
    uint(head + hashes.length / 2) + hashes + bytesTail(w.data);
  return selector("claimMessageWithProof((bytes32[],uint256,uint32,address,address,uint256,uint256,address,bytes32,bytes))") + uint(32) + tuple;
}

/** LineaRollup.claimMessage(from, to, fee, value, feeRecipient, calldata, nonce), for messages anchored one by one before Alpha v2. */
export function encodeLineaLegacyClaim(w) {
  return (
    selector("claimMessage(address,address,uint256,uint256,address,bytes,uint256)") +
    pad(w.from) + pad(w.to) + uint(w.fee) + uint(w.value) + pad(NO_FEE_RECIPIENT) + uint(7 * 32) + uint(w.nonce) + bytesTail(w.data)
  );
}

/**
 * L1ScrollMessenger.relayMessageWithProof(from, to, value, nonce, message, (uint256 batchIndex, bytes merkleProof))
 * (scroll-tech/scroll L1ScrollMessenger, selector 0xc311b6fc). `message` and the proof tuple are both dynamic; the
 * tuple holds its batchIndex then an offset (0x40) to its merkleProof bytes. Verified by a successful eth_call
 * rehearsal of a real claimable withdrawal on 10 Nov 2026.
 */
export function encodeScrollClaim(proof, w) {
  const head = 6 * 32;
  const msgEnc = bytesTail(w.message);
  const proofTuple = uint(proof.batchIndex) + uint(0x40) + bytesTail(proof.merkleProof);
  return (
    selector("relayMessageWithProof(address,address,uint256,uint256,bytes,(uint256,bytes))") +
    pad(w.from) + pad(w.to) + uint(w.value) + uint(w.nonce) +
    uint(head) + uint(head + msgEnc.length / 2) + msgEnc + proofTuple
  );
}

/**
 * The claim call for a withdrawal that is ready to claim, rehearsed from `from` (any account works). Returns an
 * error object when the check says it is not ready, or when the proof the endpoints gave did not check out.
 */
export async function buildClaim(chain, txHash, { index = 0, from = "0x000000000000000000000000000000000000dEaD", clients = (c) => clientsFor(c), doFetch } = {}) {
  if (!["arbitrum", "linea", "scroll", "polygonzkevm"].includes(chain.stack)) return { error: "bad-chain", message: "The claim builder works on Arbitrum One, Robinhood Chain, Linea, Scroll and Polygon zkEVM." };
  const r = await check(txHash, { chain: chain.id, index, clients });
  if (r.error) return r;
  const { facts: f, verdict: v } = r;
  if (v.state !== "READY_TO_CLAIM") return { error: "not-ready", state: v.state, message: v.summary };

  let to, data;
  if (chain.stack === "arbitrum") {
    if (!f.proof?.leafMatches || !f.proof?.rootConfirmed) return { error: "bad-proof", message: "The outbox proof from the L2 endpoint did not check out against this withdrawal and the Outbox's confirmed roots." };
    to = f.contracts.outbox;
    data = encodeArbitrumClaim(f.proof.hashes, f.withdrawal);
  } else if (chain.stack === "scroll") {
    if (!f.proof?.rootConfirmed) return { error: "bad-proof", message: "Scroll's proof did not fold to the on-chain withdraw root for this withdrawal." };
    to = f.contracts.l1Messenger;
    data = encodeScrollClaim(f.proof, f.withdrawal);
  } else if (chain.stack === "polygonzkevm") {
    if (!f.proof?.rootConfirmed) return { error: "bad-proof", message: "Polygon's proof did not fold to a rollup exit root recorded on Ethereum for this withdrawal." };
    to = f.contracts.bridge;
    data = encodePolygonClaim(f.proof, f.withdrawal);
  } else if (f.withdrawal.legacy) {
    to = f.contracts.rollup;
    data = encodeLineaLegacyClaim(f.withdrawal);
  } else {
    if (f.proofLookup === "failed") return { error: "rpc", message: "The public endpoints did not serve the L1 logs the proof is rebuilt from. Try again in a minute." };
    if (!f.proof?.rootConfirmed) return { error: "bad-proof", message: "The rebuilt Merkle proof did not match a root the L1 finalization added." };
    to = f.contracts.rollup;
    data = encodeLineaClaim(f.proof, f.withdrawal);
  }
  const rehearsal = await rehearse(chain.l1Rpcs, { from, to, data }, doFetch);
  let gas = null;
  if (rehearsal.ok) {
    const est = await clients(chain).l1("eth_estimateGas", [{ from, to, data }]).catch(() => null);
    gas = est ? Number(BigInt(est)) : null;
  }
  return { withdrawal: f.withdrawal, asset: f.asset, verdict: v, call: { to, value: "0", data }, rehearsal: { from, ...rehearsal, gas } };
}

/**
 * PolygonZkEVMBridgeV2.claimAsset(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot,
 * uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress,
 * uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata) — selector 0xccaa2d11. The two
 * proofs are FIXED-size bytes32[32] arrays, so they are encoded inline (32 words each, no offset); metadata is the only
 * dynamic argument, at head offset 73*32. Verified against the on-chain claimAsset ABI by an eth_call rehearsal of a
 * real claimable withdrawal.
 */
export function encodePolygonClaim(proof, w) {
  const arr = (hashes) => hashes.map(pad).join("");
  const head = 73 * 32;
  return (
    selector("claimAsset(bytes32[32],bytes32[32],uint256,bytes32,bytes32,uint32,address,uint32,address,uint256,bytes)") +
    arr(proof.smtProofLocalExitRoot) + arr(proof.smtProofRollupExitRoot) +
    uint(proof.globalIndex) + pad(proof.mainnetExitRoot) + pad(proof.rollupExitRoot) +
    uint(w.originNetwork) + pad(w.originAddress) + uint(w.destinationNetwork) + pad(w.destinationAddress) + uint(w.amount) +
    uint(head) + bytesTail(w.metadata)
  );
}
