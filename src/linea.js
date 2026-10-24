// Reads everything verdict() needs for one Linea withdrawal, starting from its L2 transaction hash.
// The flow (linea-monorepo L1MessageService and the SDK's getL2ToL1MessageStatus / getMessageProof): L2MessageService
// emits MessageSent with a message number; once the L1 rollup's currentL2BlockNumber reaches that L2 block, anyone can
// call claimMessageWithProof on L1, and isMessageClaimed(messageNumber) turns true. Messages from before L2 block
// 2,242,568 were anchored one by one (inboxL2L1MessageStatus) and are claimed with the legacy claimMessage.
// L1 reads are pinned to the finalized block, like the other readers.
import { encodeCall, selector, topic, word, wordAt, uintAt, addressAt, boolAt, decodeBytes, decodeString, keccakHex, sameAddress } from "./abi.js";

const MESSAGE_SENT = topic("MessageSent(address,address,uint256,uint256,uint256,bytes,bytes32)");
const MESSAGE_CLAIMED = topic("MessageClaimed(bytes32)");
const BLOCK_ANCHORED = topic("L2MessagingBlockAnchored(uint256)");
const ROOT_ADDED = topic("L2MerkleRootAdded(bytes32,uint256)");
const COMPLETE_BRIDGING = selector("completeBridging(address,uint256,address,uint256,bytes)");

export const LEGACY_BEFORE_BLOCK = 2_242_568; // Alpha v2: earlier messages use claimMessage (Linea docs)
const INBOX_STATUS_RECEIVED = 1n;
const PAUSE = { general: 1n, l2ToL1: 3n, completeTokenBridging: 8n }; // IPauseManager.PauseType
const L2_LOG_RANGE = 10_000; // rpc.linea.build refuses wider eth_getLogs ranges
const L1_BLOCK_SEC = 12;
const ZERO = "0x" + "0".repeat(64);

const num = (hex) => Number(BigInt(hex));
const hex = (n) => "0x" + BigInt(n).toString(16);

/** The withdrawals (MessageSent logs from the L2 message service) in an L2 receipt, in log order. */
export function withdrawalsIn(receipt, chain) {
  return receipt.logs
    .filter((l) => sameAddress(l.address, chain.l2MessageService) && l.topics[0] === MESSAGE_SENT)
    .map((l) => ({
      hash: l.topics[3],
      nonce: uintAt(l.data, 2),
      from: "0x" + l.topics[1].slice(-40),
      to: "0x" + l.topics[2].slice(-40),
      fee: uintAt(l.data, 0),
      value: uintAt(l.data, 1),
      data: decodeBytes(l.data, 3),
    }));
}

/**
 * What a withdrawal carries, from the log alone. Plain ETH has empty calldata. A canonical token bridge withdrawal is
 * a message from the L2 TokenBridge to the L1 TokenBridge calling completeBridging(nativeToken, amount, recipient,
 * nativeChainId, metadata); only that pair of senders is trusted with the label.
 */
export function assetOf(w, chain, txFrom) {
  if (w.data === "0x") return { kind: "eth", amount: w.value, from: w.from, to: w.to };
  if (sameAddress(w.from, chain.l2TokenBridge) && sameAddress(w.to, chain.l1TokenBridge) && w.data.startsWith(COMPLETE_BRIDGING)) {
    const a = "0x" + w.data.slice(10);
    return { kind: "erc20", nativeToken: addressAt(a, 0), nativeChainId: Number(uintAt(a, 3)), amount: uintAt(a, 1), from: txFrom, to: addressAt(a, 2) };
  }
  return { kind: "message", amount: w.value, from: w.from, to: w.to };
}

export async function readFacts(chain, txHash, { l1, l2 }, { index = 0 } = {}) {
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
  const [currentHex, claimedHex, inboxHex, limitHex, usedHex, endHex, pausedHex, pausedL2L1Hex] = await Promise.all([
    view(rollup, "currentL2BlockNumber()"),
    view(rollup, "isMessageClaimed(uint256)", [w.nonce]),
    view(rollup, "inboxL2L1MessageStatus(bytes32)", [w.hash]),
    view(rollup, "limitInWei()"),
    view(rollup, "currentPeriodAmountInWei()"),
    view(rollup, "currentPeriodEnd()"),
    view(rollup, "isPaused(uint8)", [PAUSE.general]),
    view(rollup, "isPaused(uint8)", [PAUSE.l2ToL1]),
  ]);

  const legacy = l2Block < LEGACY_BEFORE_BLOCK;
  const finalizedL2Block = num(currentHex);
  const asset = await checkedAsset(assetOf(w, chain, receipt.from.toLowerCase()), chain, view);
  let paused = boolAt(pausedHex, 0) || boolAt(pausedL2L1Hex, 0);
  if (asset.kind === "erc20" && !paused) {
    const [g, c] = await Promise.all([view(chain.l1TokenBridge, "isPaused(uint8)", [PAUSE.general]), view(chain.l1TokenBridge, "isPaused(uint8)", [PAUSE.completeTokenBridging])]);
    paused = boolAt(g, 0) || boolAt(c, 0);
  }

  const facts = {
    chain: chain.id,
    stack: "linea",
    l2: { txHash, blockNumber: l2Block, timestamp: num(block.timestamp), withdrawals: all.length, index },
    withdrawal: { ...w, legacy },
    asset,
    feeVault: false,
    l1: { block: finBlock, timestamp: num(fin.timestamp) },
    config: {
      finalizedL2Block,
      finalizedL2Timestamp: null,
      rateLimit: { limitWei: uintAt(limitHex, 0), usedWei: uintAt(usedHex, 0), periodEnd: num("0x" + wordAt(endHex, 0)) },
      paused,
    },
    finalized: l2Block <= finalizedL2Block,
    // A legacy message is claimable while its inbox status is RECEIVED; claiming deletes the status.
    claimed: legacy ? uintAt(inboxHex, 0) !== INBOX_STATUS_RECEIVED : boolAt(claimedHex, 0),
    claim: null,
    claimLookup: null,
    proof: null,
    proofLookup: null,
    contracts: { rollup, l2MessageService: chain.l2MessageService },
  };
  // Neither the anchoring nor the claim can come before the L2 block; this L1 block is no later than that moment.
  const from = Math.max(0, finBlock - Math.ceil((facts.l1.timestamp - facts.l2.timestamp) / L1_BLOCK_SEC));

  if (facts.claimed) {
    try {
      facts.claim = await findClaim(w, rollup, from, finBlock, l1);
      if (!facts.claim) facts.claimLookup = "not-found";
    } catch {
      facts.claimLookup = "failed";
    }
    return facts;
  }

  if (!facts.finalized) {
    const head = await l2("eth_getBlockByNumber", [hex(finalizedL2Block), false]);
    facts.config.finalizedL2Timestamp = num(head.timestamp);
    return facts;
  }

  if (!legacy) {
    try {
      facts.proof = await claimProof(w, l2Block, from, finBlock, chain, l1, l2, view);
      if (!facts.proof) facts.proofLookup = "not-found";
    } catch {
      facts.proofLookup = "failed";
    }
  }
  return facts;
}

/** Name the token on L1: an L1 token bridged out comes home as itself; a Linea-native token as its L1 bridged copy. */
async function checkedAsset(a, chain, view) {
  if (a.kind !== "erc20") return a;
  let l1Token = a.nativeToken;
  if (a.nativeChainId !== 1) {
    const r = await view(chain.l1TokenBridge, "nativeToBridgedToken(uint256,address)", [BigInt(a.nativeChainId), a.nativeToken]);
    const bridged = r ? addressAt(r, 0) : null;
    // Zero means the L1 copy does not exist yet (the first claim deploys it); tiny values are status markers.
    l1Token = bridged && BigInt(bridged) > 0xfffn ? bridged : null;
  }
  a.l1Token = l1Token ?? a.nativeToken;
  if (!l1Token) {
    a.symbol = null;
    a.decimals = null;
    return a;
  }
  const [sym, dec] = await Promise.all([view(l1Token, "symbol()"), view(l1Token, "decimals()")]);
  a.symbol = sym ? decodeString(sym) : null;
  a.decimals = dec ? num("0x" + wordAt(dec, 0)) : null;
  return a;
}

/** Who sent the claim: the MessageClaimed log for this message hash on L1, and its transaction's sender. */
async function findClaim(w, rollup, from, finBlock, l1) {
  const logs = await l1("eth_getLogs", [{ address: rollup, fromBlock: hex(from), toBlock: hex(finBlock), topics: [MESSAGE_CLAIMED, w.hash] }]);
  if (!logs.length) return null;
  const log = logs[0];
  const tx = await l1("eth_getTransactionByHash", [log.transactionHash]);
  return { by: tx.from.toLowerCase(), txHash: log.transactionHash, block: num(log.blockNumber), timestamp: log.blockTimestamp ? num(log.blockTimestamp) : null };
}

/**
 * The Merkle proof for claimMessageWithProof, rebuilt the way the SDK's getMessageProof does it: the L1 finalization
 * that anchored this L2 block lists every anchored L2 block and the tree roots; the message hashes sent in that block
 * range, in order, fill trees of 2^depth leaves (empty leaves are zero). Checked two ways: the rebuilt root must be
 * one the finalization added, and l2MerkleRootsDepths(root) on L1 must equal the depth.
 */
async function claimProof(w, l2Block, from, finBlock, chain, l1, l2, view) {
  const rollup = chain.rollup;
  const anchors = await l1("eth_getLogs", [{ address: rollup, fromBlock: hex(from), toBlock: hex(finBlock), topics: [BLOCK_ANCHORED, "0x" + word(l2Block)] }]);
  if (!anchors.length) return null;
  const receipt = await l1("eth_getTransactionReceipt", [anchors[0].transactionHash]);
  const mine = receipt.logs.filter((l) => sameAddress(l.address, rollup));
  const roots = mine.filter((l) => l.topics[0] === ROOT_ADDED).map((l) => ({ root: l.topics[1], depth: num(l.topics[2]) }));
  const blocks = mine.filter((l) => l.topics[0] === BLOCK_ANCHORED).map((l) => num(l.topics[1]));
  if (!roots.length || !blocks.length) return null;

  const lo = Math.min(...blocks);
  const hi = Math.max(...blocks);
  const hashes = [];
  for (let start = lo; start <= hi; start += L2_LOG_RANGE) {
    const logs = await l2("eth_getLogs", [{ address: chain.l2MessageService, fromBlock: hex(start), toBlock: hex(Math.min(hi, start + L2_LOG_RANGE - 1)), topics: [MESSAGE_SENT] }]);
    hashes.push(...logs.map((l) => l.topics[3]));
  }
  const at = hashes.indexOf(w.hash);
  if (at < 0) return null;

  const depth = roots[0].depth;
  const size = 2 ** depth;
  const first = Math.floor(at / size) * size;
  let level = hashes.slice(first, first + size);
  while (level.length < size) level.push(ZERO);
  const leafIndex = at - first;
  const proof = [];
  for (let i = leafIndex; level.length > 1; i >>= 1) {
    proof.push(level[i ^ 1]);
    const next = [];
    for (let k = 0; k < level.length; k += 2) next.push(keccakHex(level[k] + level[k + 1].slice(2)));
    level = next;
  }
  const root = level[0];
  const onL1 = await view(rollup, "l2MerkleRootsDepths(bytes32)", [root]);
  return {
    root,
    depth,
    leafIndex,
    hashes: proof,
    anchoredAt: num(anchors[0].blockNumber),
    rootConfirmed: roots.some((r) => r.root === root) && !!onL1 && uintAt(onL1, 0) === BigInt(depth),
  };
}
