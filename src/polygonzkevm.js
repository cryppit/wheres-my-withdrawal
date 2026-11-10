// Reads everything verdict() needs for one Polygon zkEVM withdrawal, starting from its L2 transaction hash.
//
// Polygon zkEVM (mainnet L2 chainId 1101, gas token ETH) is a validity rollup on the Polygon/AggLayer LxLy UNIFIED
// BRIDGE — its own family, NOT OP Stack and NOT Scroll-style. The PolygonZkEVMBridgeV2 contract lives at the SAME
// address on L1 and L2 (0x2a3D…2EDe; verified on chain 10 Nov 2026: L1 networkID()==0 mainnet, L2 networkID()==1
// zkEVM, and bridge.polygonRollupManager()/globalExitRootManager() name the manager and GER below). A withdrawal is a
// `BridgeEvent` log from the L2 bridge with destinationNetwork == 0 (to Ethereum); its leaf is appended to the rollup's
// local exit tree at index == depositCount. Batches are VERIFIED by a zk validity proof on L1 (PolygonRollupManager),
// which recomputes the rollup exit root and records a new global exit root in PolygonZkEVMGlobalExitRootV2 — there is
// NO fault-proof challenge delay. The user then calls `claimAsset(...)` on the L1 bridge with two depth-32 Merkle
// proofs (local exit tree + rollup exit tree), the globalIndex, the mainnet/rollup exit roots and the asset fields.
//
// Polygon runs a public, keyless, CORS-open proof API (api-gateway.polygon.technology, verified 10 Nov 2026: the
// merkle-proof route answers with no API key and sends access-control-allow-origin: *). So — exactly like Scroll — this
// reader builds a FULL claim: it fetches the Merkle proofs, then trusts them only after re-folding them on chain, up
// the local exit tree then up the rollup exit tree, and confirming the resulting global exit root is RECORDED in the
// GER on L1 (globalExitRootMap != 0) — the same check claimAsset itself makes. The API only says which roots to check;
// the on-chain GER map is the truth. A withdrawal is "done" when the bridge's isClaimed(depositCount, 1) is true.
//
// The leaf hash, the depth-32 Merkle fold, the globalIndex layout and the GER check were read from the verified
// zkevm-contracts source (PolygonZkEVMBridgeV2 / DepositContractV2, AGPL-3.0) and re-implemented here independently —
// no AGPL code is copied. Every address, the claimAsset selector (0xccaa2d11) and the fold were confirmed on chain.
//
// Stages: initiated -> waiting for batch verification (leaf not yet in a recorded global exit root) -> claimable
// (full claimAsset built, proof re-folds to an on-chain GER) -> claimed (isClaimed true). All L1 reads are pinned to
// the finalized L1 block, like every reader.
import { encodeCall, topic, wordAt, uintAt, boolAt, decodeString, keccakHex, sameAddress } from "./abi.js";

const BRIDGE_EVENT = topic("BridgeEvent(uint8,uint32,address,uint32,address,uint256,bytes,uint32)"); // all fields in data

const LEAF_TYPE_ASSET = 0;
const MAINNET_NETWORK = 0; // withdrawals to Ethereum carry destinationNetwork == 0
// zkEVM is AggLayer rollupID 1, i.e. rollupIndex 0, so a zkEVM withdrawal's globalIndex == depositCount (no mainnet
// flag, no rollup offset) — confirmed against the bridge's isClaimed()/_verifyLeaf() decode on chain.
const ZKEVM_ROLLUP_INDEX = 0n;

const num = (hex) => Number(BigInt(hex));
const strip = (h) => h.replace(/^0x/, "").toLowerCase();
const pad = (h) => strip(h).padStart(64, "0");
const uintWord = (v) => BigInt(v).toString(16).padStart(64, "0");

/**
 * The leaf value the bridge appends to the local exit tree:
 * keccak256(abi.encodePacked(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork,
 * address destinationAddress, uint256 amount, bytes32 keccak256(metadata))) — DepositContractV2.getLeafValue. Packed,
 * so the small ints are their own byte width (1/4/20 bytes), not padded to 32. Re-implemented from the verified source.
 */
export function leafValue(w) {
  const packed =
    "0x" +
    w.leafType.toString(16).padStart(2, "0") +
    w.originNetwork.toString(16).padStart(8, "0") +
    strip(w.originAddress).padStart(40, "0") +
    w.destinationNetwork.toString(16).padStart(8, "0") +
    strip(w.destinationAddress).padStart(40, "0") +
    uintWord(w.amount) +
    strip(keccakHex("0x" + strip(w.metadata)));
  return keccakHex(packed);
}

/**
 * Fold a leaf up a depth-32 exit tree with its 32-node Merkle proof, exactly as the on-chain DepositContractBase
 * calculateRoot does: for height 0..31, hash the running node with proof[height] on the side bit `height` of the index
 * chooses. Used twice — leaf -> local exit root (index = depositCount), then local exit root -> rollup exit root
 * (index = rollupIndex). The returned root is only trusted when it matches the API's root AND that global exit root is
 * recorded on L1; that is the on-chain proof we never fabricate.
 */
export function calcRoot(leaf, index, proof) {
  if (!Array.isArray(proof) || proof.length !== 32) return null;
  let node = strip(leaf);
  let idx = BigInt(index);
  for (let h = 0; h < 32; h++) {
    const sib = strip(proof[h]);
    node = strip(((idx >> BigInt(h)) & 1n) === 1n ? keccakHex("0x" + sib + node) : keccakHex("0x" + node + sib));
  }
  return "0x" + node;
}

/** The global exit root the bridge keys on: keccak256(mainnetExitRoot ++ rollupExitRoot) (GlobalExitRootLib). */
export function globalExitRoot(mainnetExitRoot, rollupExitRoot) {
  return keccakHex("0x" + pad(mainnetExitRoot) + pad(rollupExitRoot));
}

/** The withdrawals (BridgeEvent logs from the bridge with destinationNetwork == 0) in an L2 receipt, in log order. */
export function withdrawalsIn(receipt, chain) {
  return receipt.logs
    .filter((l) => sameAddress(l.address, chain.bridge) && l.topics[0] === BRIDGE_EVENT)
    .map((l) => {
      const d = l.data;
      const metaOffset = num("0x" + wordAt(d, 6)) * 2 + 2; // *2 hex chars, +2 for "0x"
      const metaLen = num("0x" + d.slice(metaOffset, metaOffset + 64)) * 2;
      return {
        leafType: num("0x" + wordAt(d, 0)),
        originNetwork: num("0x" + wordAt(d, 1)),
        originAddress: "0x" + wordAt(d, 2).slice(24),
        destinationNetwork: num("0x" + wordAt(d, 3)),
        destinationAddress: "0x" + wordAt(d, 4).slice(24),
        amount: uintAt(d, 5),
        depositCount: num("0x" + wordAt(d, 7)), // the 8th static word, before the metadata tail
        metadata: "0x" + d.slice(metaOffset + 64, metaOffset + 64 + metaLen),
      };
    })
    .filter((w) => w.destinationNetwork === MAINNET_NETWORK);
}

/**
 * What a withdrawal carries. leafType 0 is an asset: ETH when originTokenAddress is the zero address, otherwise an
 * ERC-20 whose home chain is originNetwork (0 = an Ethereum-native token like USDC, 1 = a zkEVM-native token).
 * leafType 1 is a bridged message (reported generically — never guessed).
 */
export function assetOf(w) {
  if (w.leafType !== LEAF_TYPE_ASSET) {
    return { kind: "message", from: w.originAddress, to: w.destinationAddress, amount: w.amount };
  }
  if (/^0x0+$/.test(w.originAddress)) {
    return { kind: "eth", from: w.originAddress, to: w.destinationAddress, amount: w.amount };
  }
  return { kind: "erc20", l1Token: w.originNetwork === MAINNET_NETWORK ? w.originAddress : null, l2Token: w.originNetwork === MAINNET_NETWORK ? null : w.originAddress, originNetwork: w.originNetwork, to: w.destinationAddress, from: w.originAddress, amount: w.amount };
}

/** Name an ERC-20 (symbol and decimals) on whichever chain it is native to, leaving them null when it does not answer. */
async function namedAsset(a, viewL1, viewL2) {
  if (a.kind !== "erc20") return a;
  const view = a.l1Token ? viewL1 : viewL2;
  const token = a.l1Token ?? a.l2Token;
  if (!token) return a;
  const [sym, dec] = await Promise.all([view(token, "symbol()"), view(token, "decimals()")]);
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
  w.hash = leafValue(w);
  w.globalIndex = BigInt(w.depositCount) + (ZKEVM_ROLLUP_INDEX << 32n); // == depositCount for zkEVM

  const l2Block = num(receipt.blockNumber);
  const block = await l2("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const fin = await l1("eth_getBlockByNumber", ["finalized", false]);
  const tag = fin.number;
  const finBlock = num(tag);
  const viewL1 = async (to, sig, args = []) => {
    const r = await l1("eth_call", [{ to, data: encodeCall(sig, args) }, tag]);
    return r && r.reverted ? null : r;
  };
  const viewL2 = async (to, sig, args = []) => {
    const r = await l2("eth_call", [{ to, data: encodeCall(sig, args) }, "latest"]);
    return r && r.reverted ? null : r;
  };

  const bridge = chain.bridge;
  const claimedHex = await viewL1(bridge, "isClaimed(uint32,uint32)", [BigInt(w.depositCount), 1n]);
  const asset = await namedAsset(assetOf(w), viewL1, viewL2);

  const facts = {
    chain: chain.id,
    stack: "polygonzkevm",
    l2: { txHash, blockNumber: l2Block, timestamp: num(block.timestamp), withdrawals: all.length, index },
    withdrawal: w,
    asset,
    feeVault: false,
    hashVerified: true, // the leaf is computed from the bridge's own event, not read from a second source
    l1: { block: finBlock, timestamp: num(fin.timestamp) },
    finalized: false,
    claimed: boolAt(claimedHex, 0),
    claim: null,
    claimLookup: null,
    proof: null,
    proofLookup: null,
    contracts: { bridge, rollupManager: chain.rollupManager, globalExitRoot: chain.globalExitRoot },
  };

  if (facts.claimed) {
    // Already claimed on L1 (the on-chain truth). Unlike Scroll/Morph, naming who sent the claim is NOT feasible on
    // free endpoints: the bridge's ClaimEvent is unindexed AND the LxLy bridge is shared by every AggLayer chain, so a
    // single withdrawal's claim can't be filtered out from tens of thousands of others without an archive index. We
    // report the fact of the claim and say plainly that the sender isn't identified, rather than guess.
    facts.finalized = true;
    facts.claim = null;
    facts.claimLookup = "unindexed";
    return facts;
  }

  // Not claimed: ask Polygon's proof API, then confirm finalization entirely on chain.
  let p = null;
  if (api) {
    try {
      p = await api(String(w.depositCount));
    } catch {
      facts.proofLookup = "failed";
    }
  } else {
    facts.proofLookup = "no-api";
  }

  if (p && Array.isArray(p.merkle_proof) && Array.isArray(p.rollup_merkle_proof)) {
    const apiRollupRoot = "0x" + pad(p.rollup_exit_root);
    const computedLocalRoot = calcRoot(w.hash, w.depositCount, p.merkle_proof);
    const computedRollupRoot = computedLocalRoot && calcRoot(computedLocalRoot, ZKEVM_ROLLUP_INDEX, p.rollup_merkle_proof);
    const proofFolds = !!computedRollupRoot && computedRollupRoot.toLowerCase() === apiRollupRoot.toLowerCase();
    // On-chain truth: the global exit root (mainnet + rollup) must be recorded in the GER, exactly as claimAsset checks.
    const ger = globalExitRoot(p.main_exit_root, p.rollup_exit_root);
    const recordedHex = await viewL1(chain.globalExitRoot, "globalExitRootMap(bytes32)", [ger]);
    const gerRecorded = !!recordedHex && uintAt(recordedHex, 0) !== 0n;
    const rootConfirmed = !!proofFolds && gerRecorded;
    facts.proof = {
      globalIndex: w.globalIndex,
      depositCount: w.depositCount,
      rollupIndex: Number(ZKEVM_ROLLUP_INDEX),
      smtProofLocalExitRoot: p.merkle_proof,
      smtProofRollupExitRoot: p.rollup_merkle_proof,
      mainnetExitRoot: "0x" + pad(p.main_exit_root),
      rollupExitRoot: "0x" + pad(p.rollup_exit_root),
      computedRollupRoot,
      globalExitRoot: ger,
      gerRecorded,
      proofFolds: !!proofFolds,
      rootConfirmed,
      hashes: [...p.merkle_proof, ...p.rollup_merkle_proof],
    };
    // Claimable only when BOTH on-chain facts hold: the proof folds to the API's rollup root AND that global exit root
    // is recorded on L1. Never the API's word alone.
    facts.finalized = rootConfirmed;
  } else if (p === null && facts.proofLookup == null) {
    facts.proofLookup = "not-found"; // the API answered but has no proof yet -> not verified on L1 yet
  }
  return facts;
}

