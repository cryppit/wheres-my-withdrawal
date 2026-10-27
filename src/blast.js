// Reads everything verdict() needs for one Blast withdrawal, starting from its L2 transaction hash. Blast runs the
// OP Stack's pre-fault-proof OptimismPortal (1.10.0) and L2OutputOracle, plus an ETH yield manager whose withdrawal
// queue holds every ETH withdrawal between prove and finalize. Every L1 read is pinned to the finalized block.
import { encodeCall, uintAt, wordAt, addressAt, boolAt, decodeString, keccakHex, sameAddress } from "./abi.js";
import { FEE_VAULTS } from "./chains.js";
import { withdrawalsIn, assetOf } from "./opstack.js";

const num = (hex) => Number(BigInt(hex));

export async function readFacts(chain, txHash, { l1, l2 }, { index = 0 } = {}) {
  const receipt = await l2("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { error: "not-found", message: `No ${chain.name} transaction with this hash.` };
  const all = withdrawalsIn(receipt);
  if (!all.length) return { error: "not-a-withdrawal", message: `This ${chain.name} transaction does not start a withdrawal to Ethereum.` };
  const w = all[index];
  if (!w) return { error: "bad-index", message: `This transaction has ${all.length} withdrawal(s); there is no #${index}.` };

  const block = await l2("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const asset = assetOf(w, chain);
  // Through L1BlastBridge an ERC-20 can only be USDB: finalizing puts its DAI in the USD yield manager's queue, from
  // which only the recipient can claim it (L1BlastBridge.finalizeBridgeERC20, verified source).
  const relayArgs = sameAddress(w.target, chain.l1Messenger) ? "0x" + w.data.slice(10) : null;
  const usdb = asset.kind === "erc20" && relayArgs !== null && (chain.l1ExtraBridges ?? []).some((b) => sameAddress(addressAt(relayArgs, 2), b));
  const fin = await l1("eth_getBlockByNumber", ["finalized", false]);
  const tag = fin.number;
  const view = async (to, sig, args = []) => {
    const r = await l1("eth_call", [{ to, data: encodeCall(sig, args) }, tag]);
    return r && r.reverted ? null : r;
  };

  const { portal, l2Oracle: oracle, yieldManager } = chain;
  const [finalizedHex, provenHex, periodHex, latestHex] = await Promise.all([
    view(portal, "finalizedWithdrawals(bytes32)", [w.hash]),
    view(portal, "provenWithdrawals(bytes32)", [w.hash]),
    view(oracle, "FINALIZATION_PERIOD_SECONDS()"),
    view(oracle, "latestBlockNumber()"),
  ]);
  const l2Block = num(receipt.blockNumber);
  const latest = num(latestHex);

  const facts = {
    chain: chain.id,
    stack: "blast",
    l2: { txHash, blockNumber: l2Block, timestamp: num(block.timestamp), withdrawals: all.length, index },
    withdrawal: { hash: w.hash, nonce: w.nonce, sender: w.sender, target: w.target, value: w.value, gasLimit: w.gasLimit },
    asset,
    feeVault: FEE_VAULTS.some((v) => sameAddress(v, w.sender) || sameAddress(v, asset.from)),
    usdb,
    l1: { block: num(tag), timestamp: num(fin.timestamp) },
    config: { maturitySec: num(periodHex), cadenceSec: chain.cadenceSec },
    finalized: boolAt(finalizedHex, 0),
    relay: null,
    proven: null,
    queue: null,
    coverage: { covered: latest >= l2Block, latestBlockNumber: latest, needed: l2Block },
    contracts: { portal, oracle, yieldManager },
  };

  if (asset.kind === "erc20") {
    const [sym, dec] = await Promise.all([view(asset.l1Token, "symbol()"), view(asset.l1Token, "decimals()")]);
    asset.symbol = sym ? decodeString(sym) : null;
    asset.decimals = dec ? num("0x" + wordAt(dec, 0)) : null;
  }

  if (facts.finalized) {
    if (sameAddress(w.target, chain.l1Messenger)) {
      const msgHash = keccakHex(w.data);
      const [ok, failed] = await Promise.all([
        view(chain.l1Messenger, "successfulMessages(bytes32)", [msgHash]),
        view(chain.l1Messenger, "failedMessages(bytes32)", [msgHash]),
      ]);
      facts.relay = boolAt(ok, 0) ? "ok" : boolAt(failed, 0) ? "failed" : "unknown";
    } else facts.relay = "ok";
    return facts;
  }

  // ProvenWithdrawal { bytes32 outputRoot; uint128 timestamp; uint128 l2OutputIndex; uint256 requestId }
  const provenAt = num("0x" + wordAt(provenHex, 1));
  if (provenAt > 0) {
    const outputIndex = uintAt(provenHex, 2);
    const output = await view(oracle, "getL2Output(uint256)", [outputIndex]);
    facts.proven = {
      provenAt,
      outputIndex: Number(outputIndex),
      outputRoot: "0x" + wordAt(provenHex, 0),
      currentRoot: output ? "0x" + wordAt(output, 0) : null,
      outputTimestamp: output ? num("0x" + wordAt(output, 1)) : 0,
      requestId: uintAt(provenHex, 3),
    };
    if (w.value > 0n && facts.proven.requestId > 0n) {
      const [lastFinalized, lastCheckpoint] = await Promise.all([view(yieldManager, "getLastFinalizedRequestId()"), view(yieldManager, "getLastCheckpointId()")]);
      const lastFinalizedRequestId = uintAt(lastFinalized, 0);
      let hint = 0n;
      if (facts.proven.requestId <= lastFinalizedRequestId) {
        hint = uintAt(await view(yieldManager, "findCheckpointHint(uint256,uint256,uint256)", [facts.proven.requestId, 1n, uintAt(lastCheckpoint, 0)]), 0);
      }
      facts.queue = { lastFinalizedRequestId, hint };
    }
  }
  return facts;
}
