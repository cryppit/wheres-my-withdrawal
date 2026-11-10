// Reads everything verdict() needs for one Morph withdrawal, starting from its L2 transaction hash.
//
// Morph is a Scroll-style rollup (morph-l2/morph on GitHub, verified on chain 10 Nov 2026). A withdrawal is a
// `SentMessage` log from the L2CrossDomainMessenger (predeploy 0x53..07); the message hash is appended to an
// append-only withdraw tree in the L2ToL1MessagePasser (0x53..01, one `AppendMessage` log per withdrawal). Sequencers
// commit each batch's withdraw-tree root to the L1 Rollup; after a challenge period (Rollup.finalizationPeriodSeconds,
// read live — 2 days on mainnet, 7 days on the Holesky testnet) the batch is finalized and its root is marked in
// Rollup.withdrawalRoots. The claim is L1CrossDomainMessenger.proveAndRelayMessage(from, to, value, nonce, message,
// bytes32[32] withdrawalProof, bytes32 withdrawalRoot); on success it sets finalizedWithdrawals[hash]=true and emits
// RelayedMessage(hash). That Merkle proof is produced by Morph's bridge backend (not reconstructable from any public
// endpoint), so this reader tracks STATUS only and the verdict hands the claim off to Morph's bridge app.
//
// Stages: initiated (SentMessage) -> committed (batch covering the L2 block is committed, in the challenge window)
// -> finalized / claimable (batch finalized) -> claimed (finalizedWithdrawals true). All L1 reads are pinned to the
// finalized L1 block, like the other readers.
import { encodeCall, selector, topic, wordAt, uintAt, addressAt, boolAt, decodeBytes, decodeString, keccakHex, sameAddress } from "./abi.js";

const SENT_MESSAGE = topic("SentMessage(address,address,uint256,uint256,uint256,bytes)");
const APPEND_MESSAGE = topic("AppendMessage(uint256,bytes32,bytes32)");
const RELAYED_MESSAGE = topic("RelayedMessage(bytes32)");

const FINALIZE_WITHDRAW_ETH = selector("finalizeWithdrawETH(address,address,uint256,bytes)"); // 0x8eaac8a3
const FINALIZE_WITHDRAW_ERC20 = selector("finalizeWithdrawERC20(address,address,address,address,uint256,bytes)"); // 0x84bd13b0

// L2 predeploys (morph-l2/morph libraries/constants/Predeploys.sol). The fee vault's withdrawals are protocol revenue.
const L2_TX_FEE_VAULT = "0x530000000000000000000000000000000000000a";

const L1_BLOCK_SEC = 12;

const num = (hex) => Number(BigInt(hex));
const hex = (n) => "0x" + BigInt(n).toString(16);

const strip = (h) => h.replace(/^0x/, "");
const pad = (h) => strip(h).toLowerCase().padStart(64, "0");
const uintWord = (v) => BigInt(v).toString(16).padStart(64, "0");
const bytesTail = (h) => {
  const b = strip(h).toLowerCase();
  return uintWord(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, "0");
};

/**
 * The cross-domain message hash: keccak256(abi.encodeWithSignature("relayMessage(address,address,uint256,uint256,
 * bytes)", from, target, value, nonce, message)) — exactly what the L2 messenger appends to the withdraw tree and
 * what proveAndRelayMessage / finalizedWithdrawals key on. Verified byte-for-byte against the on-chain AppendMessage
 * log for a real withdrawal (10 Nov 2026).
 */
export function messageHash(w) {
  const data =
    selector("relayMessage(address,address,uint256,uint256,bytes)") +
    pad(w.from) + pad(w.to) + uintWord(w.value) + uintWord(w.nonce) + uintWord(5 * 32) + bytesTail(w.message);
  return keccakHex(data);
}

/** The withdrawals (SentMessage logs from the L2 messenger) in an L2 receipt, in log order. */
export function withdrawalsIn(receipt, chain) {
  return receipt.logs
    .filter((l) => sameAddress(l.address, chain.l2Messenger) && l.topics[0] === SENT_MESSAGE)
    .map((l) => {
      const w = {
        from: "0x" + l.topics[1].slice(-40),
        to: "0x" + l.topics[2].slice(-40),
        value: uintAt(l.data, 0),
        nonce: uintAt(l.data, 1),
        gasLimit: uintAt(l.data, 2),
        message: decodeBytes(l.data, 3),
      };
      w.hash = messageHash(w);
      return w;
    });
}

/**
 * What a withdrawal carries. ETH goes out through the L2 ETH gateway as finalizeWithdrawETH(from, to, amount, data);
 * a standard ERC-20 as finalizeWithdrawERC20(l1Token, l2Token, from, to, amount, data). Anything else (custom gateway,
 * NFT, a bare message) is reported generically — never guessed.
 */
export function assetOf(w) {
  const m = w.message;
  if (m.startsWith(FINALIZE_WITHDRAW_ETH)) {
    const a = "0x" + m.slice(10);
    return { kind: "eth", from: addressAt(a, 0), to: addressAt(a, 1), amount: uintAt(a, 2) };
  }
  if (m.startsWith(FINALIZE_WITHDRAW_ERC20)) {
    const a = "0x" + m.slice(10);
    return { kind: "erc20", l1Token: addressAt(a, 0), from: addressAt(a, 2), to: addressAt(a, 3), amount: uintAt(a, 4) };
  }
  if (m === "0x") return { kind: "eth", from: w.from, to: w.to, amount: w.value };
  return { kind: "message", from: w.from, to: w.to, amount: w.value };
}

/** Name an ERC-20 on L1 from its address (symbol and decimals), leaving them null when the token does not answer. */
async function namedAsset(a, view) {
  if (a.kind !== "erc20") return a;
  const [sym, dec] = await Promise.all([view(a.l1Token, "symbol()"), view(a.l1Token, "decimals()")]);
  a.symbol = sym ? decodeString(sym) : null;
  a.decimals = dec ? num("0x" + wordAt(dec, 0)) : null;
  return a;
}

export async function readFacts(chain, txHash, { l1, l2, l1Archive = l1 }, { index = 0 } = {}) {
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
  // Cross-check: the L2ToL1MessagePasser's AppendMessage log must carry this message's hash at index == nonce. A
  // mismatch would mean we read the message wrong, so we surface it rather than trust a stale read.
  const append = receipt.logs.find((l) => sameAddress(l.address, chain.l2MessagePasser) && l.topics[0] === APPEND_MESSAGE && uintAt(l.topics[1], 0) === w.nonce);
  const hashVerified = !!append && append.topics[2].toLowerCase() === w.hash.toLowerCase();

  const [claimedHex, periodHex, lfbHex, lcbHex] = await Promise.all([
    view(l1Messenger, "finalizedWithdrawals(bytes32)", [w.hash]),
    view(rollup, "finalizationPeriodSeconds()"),
    view(rollup, "lastFinalizedBatchIndex()"),
    view(rollup, "lastCommittedBatchIndex()"),
  ]);
  const challengePeriodSec = periodHex ? num("0x" + wordAt(periodHex, 0)) : chain.challengePeriodSec;
  const lastFinalizedBatchIndex = num(lfbHex);
  const lastCommittedBatchIndex = num(lcbHex);
  // batchDataStore(i) = (originTimestamp, finalizeTimestamp, blockNumber, submitter). The entry below the last
  // finalized batch is deleted on finalize, so we only read the last finalized one and committed-but-unfinalized ones.
  const batchData = async (i) => {
    const d = await view(rollup, "batchDataStore(uint256)", [BigInt(i)]);
    return d ? { originTimestamp: num("0x" + wordAt(d, 0)), finalizeTimestamp: num("0x" + wordAt(d, 1)), blockNumber: num("0x" + wordAt(d, 2)), submitter: addressAt(d, 3) } : null;
  };
  const finalizedBatch = await batchData(lastFinalizedBatchIndex);
  const finalizedBoundaryBlock = finalizedBatch ? finalizedBatch.blockNumber : 0;

  const asset = await namedAsset(assetOf(w), view);
  const facts = {
    chain: chain.id,
    stack: "morph",
    l2: { txHash, blockNumber: l2Block, timestamp: num(block.timestamp), withdrawals: all.length, index },
    withdrawal: w,
    asset,
    feeVault: sameAddress(asset.from, L2_TX_FEE_VAULT),
    hashVerified,
    l1: { block: finBlock, timestamp: num(fin.timestamp) },
    config: { challengePeriodSec, lastFinalizedBatchIndex, lastCommittedBatchIndex, finalizedBoundaryBlock },
    finalized: l2Block <= finalizedBoundaryBlock,
    committed: false,
    claimed: boolAt(claimedHex, 0),
    challenge: null,
    claim: null,
    claimLookup: null,
    contracts: { rollup, l1Messenger, l2Messenger: chain.l2Messenger },
  };

  if (facts.claimed) {
    // All L1 reads keyed on this message hash, so the batch bookkeeping is moot once it is claimed.
    const from = Math.max(0, finBlock - Math.ceil((facts.l1.timestamp - facts.l2.timestamp) / L1_BLOCK_SEC));
    try {
      facts.claim = await findClaim(w, l1Messenger, from, finBlock, l1Archive);
      if (!facts.claim) facts.claimLookup = "not-found";
    } catch {
      facts.claimLookup = "failed";
    }
    return facts;
  }

  if (facts.finalized) return facts; // in a finalized batch, not yet claimed: claimable (handoff)

  // Not finalized: is the batch covering this L2 block committed (in the challenge window) or not yet posted?
  const committedBatch = await batchData(lastCommittedBatchIndex);
  const committedBoundaryBlock = committedBatch ? committedBatch.blockNumber : 0;
  if (committedBatch && l2Block <= committedBoundaryBlock) {
    facts.committed = true;
    const i = await firstBatchCovering(l2Block, lastFinalizedBatchIndex + 1, lastCommittedBatchIndex, batchData);
    const bd = i === lastCommittedBatchIndex ? committedBatch : await batchData(i);
    facts.challenge = { batchIndex: i, finalizeTimestamp: bd ? bd.finalizeTimestamp : null, committedAt: bd ? bd.originTimestamp : null };
  }
  return facts;
}

/**
 * The smallest committed batch index in [lo, hi] whose last L2 block (batchDataStore.blockNumber) is >= l2Block, i.e.
 * the batch that contains l2Block. Batch block numbers rise with the index, so a binary search needs ~log2 reads.
 */
async function firstBatchCovering(l2Block, lo, hi, batchData) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const bd = await batchData(mid);
    if (bd && bd.blockNumber >= l2Block) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Who sent the claim: the RelayedMessage log for this message hash on the L1 messenger, and its transaction's sender. */
async function findClaim(w, l1Messenger, from, finBlock, l1) {
  const logs = await l1("eth_getLogs", [{ address: l1Messenger, fromBlock: hex(from), toBlock: hex(finBlock), topics: [RELAYED_MESSAGE, w.hash] }]);
  if (!logs.length) return null;
  const log = logs[0];
  const tx = await l1("eth_getTransactionByHash", [log.transactionHash]);
  return { by: tx.from.toLowerCase(), txHash: log.transactionHash, block: num(log.blockNumber), timestamp: log.blockTimestamp ? num(log.blockTimestamp) : null };
}
