// Reads everything verdict() needs for one Scroll withdrawal, starting from its L2 transaction hash.
//
// Scroll is the ORIGINAL of this rollup family; Morph (src/morph.js) is a fork of it, so the two share the withdrawal
// mechanism and this reader reuses Morph's shared pieces directly: the SentMessage parse (withdrawalsIn), the asset
// decode (assetOf) and the cross-domain message hash (messageHash) — all identical byte-for-byte on both chains,
// verified on chain on 10 Nov 2026. A withdrawal is a `SentMessage` log from the L2ScrollMessenger; its hash is
// appended to the append-only withdraw tree in the L2MessageQueue (one `AppendMessage(index, messageHash)` log per
// withdrawal). Sequencers commit each batch to the ScrollChain rollup and finalize it with a validity proof — there is
// NO fault-proof challenge delay (ScrollChain has no finalizationPeriodSeconds; it reverts), so a batch is final the
// moment its validity proof is verified and withdrawRoots(batchIndex) is set. The claim is
// L1ScrollMessenger.relayMessageWithProof(from, to, value, nonce, message, (uint256 batchIndex, bytes merkleProof));
// on success L1ScrollMessenger.isL2MessageExecuted(hash) turns true and it emits RelayedMessage(hash).
//
// Unlike Morph, Scroll publishes that Merkle proof on a public, keyless, CORS-open bridge-history API, so this reader
// builds a FULL claim: it fetches the proof, then trusts it only after re-folding it on chain to withdrawRoots(batch)
// and confirming isBatchFinalized(batch). The API just says which batch to check; the on-chain root is the truth.
//
// Stages: initiated -> waiting for finalization (not yet in a finalized batch) -> claimable (finalized; full claim
// built) -> claimed (isL2MessageExecuted true). All L1 reads are pinned to the finalized L1 block, like every reader.
import { encodeCall, topic, wordAt, uintAt, boolAt, decodeString, keccakHex, sameAddress } from "./abi.js";
import { messageHash, withdrawalsIn, assetOf } from "./morph.js";

const APPEND_MESSAGE = topic("AppendMessage(uint256,bytes32)"); // Scroll: both fields in data, neither indexed
const RELAYED_MESSAGE = topic("RelayedMessage(bytes32)");

const L1_BLOCK_SEC = 12;
const num = (hex) => Number(BigInt(hex));
const hex = (n) => "0x" + BigInt(n).toString(16);
const strip = (h) => h.replace(/^0x/, "").toLowerCase();

/**
 * Fold a leaf up a Scroll withdraw tree with its Merkle proof, exactly as the on-chain WithdrawTrieVerifier does
 * (scroll-tech/scroll libraries/verifier/WithdrawTrieVerifier.sol): walk the concatenated bytes32 proof, hashing the
 * running value with each sibling on the side the leaf index chooses, halving the index each step. The returned root
 * must equal ScrollChain.withdrawRoots(batchIndex); that equality is the on-chain proof we never fabricate.
 */
export function foldProof(leaf, nonce, merkleProof) {
  const chunks = strip(merkleProof).match(/.{1,64}/g)?.filter((c) => c.length === 64) ?? [];
  let h = strip(leaf);
  let idx = BigInt(nonce);
  for (const sibling of chunks) {
    h = strip(idx % 2n === 0n ? keccakHex("0x" + h + sibling) : keccakHex("0x" + sibling + h));
    idx >>= 1n;
  }
  return { root: "0x" + h, hashes: chunks.map((c) => "0x" + c) };
}

/** Name an ERC-20 on L1 from its address (symbol and decimals), leaving them null when the token does not answer. */
async function namedAsset(a, view) {
  if (a.kind !== "erc20") return a;
  const [sym, dec] = await Promise.all([view(a.l1Token, "symbol()"), view(a.l1Token, "decimals()")]);
  a.symbol = sym ? decodeString(sym) : null;
  a.decimals = dec ? num("0x" + wordAt(dec, 0)) : null;
  return a;
}

export async function readFacts(chain, txHash, { l1, l2, l1Archive = l1, api }, { index = 0 } = {}) {
  const receipt = await l2("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { error: "not-found", message: `No ${chain.name} transaction with this hash.` };
  const all = withdrawalsIn(receipt, chain);
  if (!all.length) return { error: "not-a-withdrawal", message: `This ${chain.name} transaction does not start a withdrawal to Ethereum.` };
  const w = all[index];
  if (!w) return { error: "bad-index", message: `This transaction has ${all.length} withdrawal(s); there is no #${index}.` };

  const l2Block = num(receipt.blockNumber);
  const block = await l2("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const fin = await l1("eth_getBlockByNumber", ["finalized", false]);
  const tag = fin.number;
  const finBlock = num(tag);
  const view = async (to, sig, args = []) => {
    const r = await l1("eth_call", [{ to, data: encodeCall(sig, args) }, tag]);
    return r && r.reverted ? null : r;
  };

  const rollup = chain.rollup;
  const l1Messenger = chain.l1Messenger;
  // Cross-check: the L2MessageQueue's AppendMessage(index, messageHash) log at index == nonce must carry this hash.
  // A mismatch means we read the message wrong, so we surface it rather than trust a stale read.
  const append = receipt.logs.find((l) => sameAddress(l.address, chain.l2MessageQueue) && l.topics[0] === APPEND_MESSAGE && uintAt(l.data, 0) === w.nonce);
  const hashVerified = !!append && ("0x" + wordAt(append.data, 1)).toLowerCase() === w.hash.toLowerCase();

  const [claimedHex, lfbHex] = await Promise.all([
    view(l1Messenger, "isL2MessageExecuted(bytes32)", [w.hash]),
    view(rollup, "lastFinalizedBatchIndex()"),
  ]);

  const asset = await namedAsset(assetOf(w), view);
  const facts = {
    chain: chain.id,
    stack: "scroll",
    l2: { txHash, blockNumber: l2Block, timestamp: num(block.timestamp), withdrawals: all.length, index },
    withdrawal: w,
    asset,
    feeVault: false,
    hashVerified,
    l1: { block: finBlock, timestamp: num(fin.timestamp) },
    config: { lastFinalizedBatchIndex: num(lfbHex) },
    finalized: false,
    claimed: boolAt(claimedHex, 0),
    claim: null,
    claimLookup: null,
    proof: null,
    proofLookup: null,
    batch: null,
    contracts: { rollup, l1Messenger, l2Messenger: chain.l2Messenger },
  };

  if (facts.claimed) {
    // Already executed on L1: the batch bookkeeping is moot; just name who sent the claim.
    facts.finalized = true;
    const from = Math.max(0, finBlock - Math.ceil((facts.l1.timestamp - facts.l2.timestamp) / L1_BLOCK_SEC));
    try {
      facts.claim = await findClaim(w, l1Messenger, from, finBlock, l1Archive);
      if (!facts.claim) facts.claimLookup = "not-found";
    } catch {
      facts.claimLookup = "failed";
    }
    return facts;
  }

  // Not claimed: ask Scroll's bridge API for the proof, then confirm finalization entirely on chain.
  let info = null;
  if (api) {
    try {
      info = await api(txHash);
    } catch {
      facts.proofLookup = "failed";
    }
  } else {
    facts.proofLookup = "no-api";
  }

  const rawProof = info?.claim_info?.proof?.merkle_proof;
  const batchIndex = info?.claim_info?.proof?.batch_index != null ? Number(info.claim_info.proof.batch_index) : null;
  if (rawProof && batchIndex) {
    const [finBatchHex, rootHex] = await Promise.all([
      view(rollup, "isBatchFinalized(uint256)", [BigInt(batchIndex)]),
      view(rollup, "withdrawRoots(uint256)", [BigInt(batchIndex)]),
    ]);
    const batchFinalized = boolAt(finBatchHex, 0);
    const onchainRoot = rootHex ? "0x" + wordAt(rootHex, 0) : null;
    const folded = foldProof(w.hash, w.nonce, rawProof);
    const rootConfirmed = !!onchainRoot && folded.root.toLowerCase() === onchainRoot.toLowerCase();
    facts.batch = { index: batchIndex, finalized: batchFinalized };
    facts.proof = { batchIndex, merkleProof: "0x" + strip(rawProof), hashes: folded.hashes, root: folded.root, onchainRoot, rootConfirmed };
    // Claimable only when BOTH on-chain facts hold: the batch is finalized AND the proof folds to its on-chain root.
    facts.finalized = batchFinalized && rootConfirmed;
  } else if (info && facts.proofLookup == null) {
    facts.proofLookup = "not-found"; // the API knows the tx but has no proof yet -> not finalized
  }
  return facts;
}

/** Who sent the claim: the RelayedMessage log for this message hash on the L1 messenger, and its transaction's sender. */
async function findClaim(w, l1Messenger, from, finBlock, l1) {
  const logs = await l1("eth_getLogs", [{ address: l1Messenger, fromBlock: hex(from), toBlock: hex(finBlock), topics: [RELAYED_MESSAGE, w.hash] }]);
  if (!logs.length) return null;
  const log = logs[0];
  const tx = await l1("eth_getTransactionByHash", [log.transactionHash]);
  return { by: tx.from.toLowerCase(), txHash: log.transactionHash, block: num(log.blockNumber), timestamp: log.blockTimestamp ? num(log.blockTimestamp) : null };
}
