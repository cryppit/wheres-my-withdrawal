// Reads everything verdict() needs for one ZKsync Era withdrawal, starting from its L2 transaction hash.
// The flow (era-contracts v31 L1Nullifier, L1Messenger and DataEncoding): a bridge contract on L2 calls
// L1Messenger.sendToL1(message), which emits L1MessageSent and an L2-to-L1 log in the transaction's batch. Once that
// batch is executed on L1, anyone can call L1Nullifier.finalizeDeposit with a proof from zks_getL2ToL1LogProof, and
// isWithdrawalFinalized(chainId, batch, messageIndex) turns true. Withdrawals finalized before the shared bridge are
// recorded on the Era diamond (ETH) or the legacy L1ERC20Bridge (tokens) instead. L1 reads are pinned to the finalized
// block, like the other readers.
import { encodeCall, selector, topic, word, wordAt, uintAt, addressAt, boolAt, decodeBytes, decodeString, sameAddress } from "./abi.js";
import { ZKSYNC } from "./chains.js";

const L1_MESSAGE_SENT = topic("L1MessageSent(address,bytes32,bytes)");
// The three message formats the L1Nullifier accepts (_parseL2WithdrawalMessage), told apart by their first 4 bytes.
const BASE_TOKEN_WITHDRAWAL = selector("finalizeEthWithdrawal(uint256,uint256,uint16,bytes,bytes32[])");
const LEGACY_TOKEN_WITHDRAWAL = selector("finalizeWithdrawal(uint256,uint256,uint16,bytes,bytes32[])");
const ASSET_ROUTER_WITHDRAWAL = selector("finalizeDeposit(uint256,bytes32,bytes)");
const FINALIZE_DEPOSIT = selector("finalizeDeposit((uint256,uint256,uint256,address,uint16,bytes,bytes32[]))");
const ETH_TOKEN = "0x0000000000000000000000000000000000000001"; // the native token vault's name for ETH

const L1_BLOCK_SEC = 12;
const num = (hex) => Number(BigInt(hex));
const hex = (n) => "0x" + BigInt(n).toString(16);
const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);
const isTrue = (r) => !!r && boolAt(r, 0);
const seconds = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

/** The bridge withdrawals (L1MessageSent from a bridge contract) in an L2 receipt, in log order. */
export function withdrawalsIn(receipt, chain) {
  const bridges = [ZKSYNC.baseToken, ZKSYNC.assetRouter, chain.l2LegacyBridge];
  const seen = {};
  return messagesIn(receipt)
    .map((m) => {
      // Which of the transaction's L2-to-L1 logs carries this message: the proof RPC counts them per transaction.
      seen[m.hash] = (seen[m.hash] ?? -1) + 1;
      const matches = receipt.l2ToL1Logs.map((l, i) => (sameAddress(l.sender, ZKSYNC.l1Messenger) && l.value === m.hash ? i : -1)).filter((i) => i >= 0);
      return { ...m, logIndex: matches[seen[m.hash]] ?? null };
    })
    .filter((m) => bridges.some((b) => sameAddress(b, m.sender)));
}

const messagesIn = (receipt) =>
  receipt.logs
    .filter((l) => sameAddress(l.address, ZKSYNC.l1Messenger) && l.topics[0] === L1_MESSAGE_SENT)
    .map((l) => ({ sender: "0x" + l.topics[1].slice(-40), hash: l.topics[2], message: decodeBytes(l.data, 0) }));

/** What a withdrawal carries, from the message alone (packed encodings, DataEncoding.sol). */
export function assetOf(w, txFrom) {
  const m = strip(w.message);
  const addr = (at) => "0x" + m.slice(at, at + 40);
  const uint = (at) => BigInt("0x" + m.slice(at, at + 64));
  if (w.message.startsWith(BASE_TOKEN_WITHDRAWAL)) return { kind: "eth", amount: uint(48), from: txFrom, to: addr(8) };
  if (w.message.startsWith(LEGACY_TOKEN_WITHDRAWAL)) return { kind: "erc20", l1Token: addr(48), amount: uint(88), from: txFrom, to: addr(8) };
  if (w.message.startsWith(ASSET_ROUTER_WITHDRAWAL)) {
    // chainId, assetId, then transferData = abi.encode(originalCaller, receiver, originToken, amount, metadata).
    const data = "0x" + m.slice(8 + 128);
    return { kind: "erc20", assetId: "0x" + m.slice(8 + 64, 8 + 128), l1Token: null, amount: uintAt(data, 3), from: txFrom, to: addressAt(data, 1) };
  }
  return { kind: "message", from: txFrom, to: null };
}

/**
 * `clients.l1Archive` serves old state (MEV Blocker, Tenderly); it defaults to `l1`.
 * With `deferClaim`, a finalized withdrawal comes back with claimLookup "pending" and no history search: claimOf()
 * fills in who sent the finalize transaction afterwards, so the page can show the verdict first.
 */
export async function readFacts(chain, txHash, { l1, l2, l1Archive = l1 }, { index = 0, deferClaim = false } = {}) {
  const receipt = await l2("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { error: "not-found", message: `No ${chain.name} transaction with this hash.` };
  const all = withdrawalsIn(receipt, chain);
  if (!all.length) {
    if (messagesIn(receipt).length) {
      return { error: "unsupported", message: "This transaction sends an L2-to-L1 message to a contract on Ethereum, not a bridge withdrawal. Only withdrawals through the ZKsync bridge are read." };
    }
    return { error: "not-a-withdrawal", message: `This ${chain.name} transaction does not start a withdrawal to Ethereum.` };
  }
  const w = all[index];
  if (!w) return { error: "bad-index", message: `This transaction has ${all.length} withdrawal(s); there is no #${index}.` };

  const block = await l2("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const fin = await l1("eth_getBlockByNumber", ["finalized", false]);
  const tag = fin.number;
  const finBlock = num(tag);
  const view = async (to, sig, args = [], at = tag) => {
    const r = await l1("eth_call", [{ to, data: encodeCall(sig, args) }, at]);
    return r && r.reverted ? null : r;
  };

  const batch = receipt.l1BatchNumber == null ? null : num(receipt.l1BatchNumber);
  const totalExecuted = num(await view(chain.diamond, "getTotalBatchesExecuted()"));
  const asset = await checkedAsset(assetOf(w, receipt.from.toLowerCase()), chain, view);

  const facts = {
    chain: chain.id,
    stack: "zksync",
    l2: { txHash, blockNumber: num(receipt.blockNumber), timestamp: num(block.timestamp), withdrawals: all.length, index },
    withdrawal: { hash: w.hash, sender: w.sender, message: w.message, batch, txNumberInBatch: receipt.l1BatchTxIndex == null ? null : num(receipt.l1BatchTxIndex), logIndex: w.logIndex, index: null },
    asset,
    feeVault: false,
    l1: { block: finBlock, timestamp: num(fin.timestamp) },
    batch: { number: batch, totalExecuted, executed: batch != null && batch <= totalExecuted, timestamp: null, committedAt: null },
    latest: null,
    finalized: false,
    finalizedBy: null,
    claim: null,
    claimLookup: null,
    proof: null,
    contracts: { nullifier: chain.nullifier, diamond: chain.diamond, legacyBridge: chain.l1LegacyBridge },
  };

  // The proof RPC answers only once the batch is executed; it also gives the message's index in the batch.
  const p = facts.batch.executed ? await l2("zks_getL2ToL1LogProof", [txHash, w.logIndex]) : null;
  if (!p) {
    facts.batch.executed = false; // executed on L1 but not yet seen by the L2 node: the verdict says it is due
    const [mine, latest] = await Promise.all([batch == null ? null : l2("zks_getL1BatchDetails", [batch]), l2("zks_getL1BatchDetails", [totalExecuted])]);
    if (mine) Object.assign(facts.batch, { timestamp: mine.timestamp, committedAt: seconds(mine.committedAt) });
    facts.latest = { number: totalExecuted, timestamp: latest.timestamp, committedAt: seconds(latest.committedAt), executedAt: seconds(latest.executedAt) };
    return facts;
  }
  facts.withdrawal.index = p.id;

  const [nullified, legacyEth, legacyToken] = await Promise.all([
    view(chain.nullifier, "isWithdrawalFinalized(uint256,uint256,uint256)", [BigInt(chain.l2ChainId), BigInt(batch), BigInt(p.id)]),
    view(chain.diamond, "isEthWithdrawalFinalized(uint256,uint256)", [BigInt(batch), BigInt(p.id)]),
    view(chain.l1LegacyBridge, "isWithdrawalFinalized(uint256,uint256)", [BigInt(batch), BigInt(p.id)]),
  ]);
  facts.finalizedBy = isTrue(nullified) ? "nullifier" : isTrue(legacyEth) ? "legacy-eth" : isTrue(legacyToken) ? "legacy-erc20" : null;
  facts.finalized = !!facts.finalizedBy;

  if (facts.finalized) {
    if (deferClaim) facts.claimLookup = "pending";
    else Object.assign(facts, await claimOf(facts, { l1, l1Archive }, chain));
    return facts;
  }

  // A dry run of the exact call at the finalized block: it succeeds only if the proof, the batch and the message match.
  const sim = await l1("eth_call", [{ to: chain.nullifier, data: encodeFinalizeDeposit(chain.l2ChainId, facts.withdrawal, p.proof) }, tag]);
  facts.proof = { id: p.id, root: p.root, hashes: p.proof, simulated: !(sim && sim.reverted) };
  return facts;
}

/** Name the token on L1: legacy messages carry it; asset-router messages carry an asset id the native token vault maps. */
async function checkedAsset(a, chain, view) {
  if (a.kind !== "erc20") return a;
  if (a.assetId) {
    const t = await view(chain.nativeTokenVault, "tokenAddress(bytes32)", [a.assetId]);
    a.l1Token = t ? addressAt(t, 0) : null;
    if (sameAddress(a.l1Token, ETH_TOKEN)) return { kind: "eth", amount: a.amount, from: a.from, to: a.to };
    if (!a.l1Token || BigInt(a.l1Token) === 0n) {
      a.l1Token = a.assetId;
      a.symbol = null;
      a.decimals = null;
      return a;
    }
  }
  const [sym, dec] = await Promise.all([view(a.l1Token, "symbol()"), view(a.l1Token, "decimals()")]);
  a.symbol = sym ? decodeString(sym) : null;
  a.decimals = dec ? num("0x" + wordAt(dec, 0)) : null;
  return a;
}

/** Calldata for L1Nullifier.finalizeDeposit(FinalizeL1DepositParams): one dynamic tuple, so it needs its own encoder. */
export function encodeFinalizeDeposit(chainId, w, proof) {
  const msg = strip(w.message);
  const bytes = word(BigInt(msg.length / 2)) + msg.padEnd(Math.ceil(msg.length / 64) * 64, "0");
  const head = [chainId, w.batch, w.index, w.sender, w.txNumberInBatch].map((v) => word(typeof v === "string" ? v : BigInt(v))).join("");
  const offsetMessage = 7 * 32;
  const offsetProof = offsetMessage + bytes.length / 2;
  return FINALIZE_DEPOSIT + word(32n) + head + word(BigInt(offsetMessage)) + word(BigInt(offsetProof)) + bytes + word(BigInt(proof.length)) + proof.map(word).join("");
}

/**
 * Who sent the finalize transaction of a finalized withdrawal: { claim, claimLookup }, like Arbitrum's claimOf.
 * claimLookup is null when found, "not-found" when no single transaction matched, "failed" when no endpoint served
 * the history.
 */
export async function claimOf(facts, { l1, l1Archive = l1 }, chain) {
  const rpc = l1Archive;
  const view = async (to, sig, args, at) => {
    const r = await rpc("eth_call", [{ to, data: encodeCall(sig, args) }, at]);
    return r && r.reverted ? null : r;
  };
  try {
    const claim = await findFinalizer(facts, chain, facts.l1.block, rpc, view);
    return { claim, claimLookup: claim ? null : "not-found" };
  } catch {
    return { claim: null, claimLookup: "failed" };
  }
}

/**
 * Who sent the finalize transaction. The contracts keep no record of it, so find the first L1 block where the
 * finalized flag is true (a four-way search on historical state, which needs an archive endpoint), then the logs the
 * bridge contracts emitted in that block, and the one transaction whose logs name this withdrawal's recipient and
 * amount. Every
 * era's finalize event carries the recipient (BridgeMint, WithdrawalFinalizedSharedBridge, EthWithdrawalFinalized,
 * WithdrawalFinalized). The search starts at the batch's own time: nothing can be finalized before that.
 */
async function findFinalizer(f, chain, finBlock, l1, view) {
  const { batch, index } = f.withdrawal;
  const [target, sig, args] = {
    nullifier: [chain.nullifier, "isWithdrawalFinalized(uint256,uint256,uint256)", [BigInt(chain.l2ChainId), BigInt(batch), BigInt(index)]],
    "legacy-eth": [chain.diamond, "isEthWithdrawalFinalized(uint256,uint256)", [BigInt(batch), BigInt(index)]],
    "legacy-erc20": [chain.l1LegacyBridge, "isWithdrawalFinalized(uint256,uint256)", [BigInt(batch), BigInt(index)]],
  }[f.finalizedBy];
  // Archive reads from the free endpoint sometimes fail under a burst of probes; one retry is usually enough.
  const read = (b) => view(target, sig, args, hex(b));
  const doneAt = async (b) => isTrue(await read(b).catch(() => read(b)));

  let lo = Math.max(0, finBlock - Math.ceil((f.l1.timestamp - f.l2.timestamp) / L1_BLOCK_SEC));
  let hi = finBlock; // finalized here
  while (lo < hi) {
    const probes = [...new Set([1, 2, 3].map((i) => lo + Math.floor(((hi - lo) * i) / 4)))].filter((p) => p < hi);
    const done = await Promise.all(probes.map(doneAt));
    const first = done.indexOf(true);
    if (first >= 0) {
      hi = probes[first];
      if (first > 0) lo = probes[first - 1] + 1;
    } else lo = probes[probes.length - 1] + 1;
  }

  const addresses = [chain.nativeTokenVault, chain.nullifier, chain.diamond, chain.l1LegacyBridge];
  const logs = await l1("eth_getLogs", [{ address: addresses, fromBlock: hex(hi), toBlock: hex(hi) }]);
  // One sender can finalize several withdrawals to the same recipient in one block, so match the amount too.
  const recipient = strip(f.asset.to ?? "").toLowerCase();
  const amount = f.asset.amount != null ? word(f.asset.amount) : null;
  const names = (l) => {
    const text = (l.data + l.topics.join("")).toLowerCase();
    return recipient && amount && text.includes(recipient) && strip(l.data).match(/.{64}/g)?.includes(amount);
  };
  const txs = [...new Set(logs.filter(names).map((l) => l.transactionHash))];
  if (txs.length !== 1) return null;
  const tx = await l1("eth_getTransactionByHash", [txs[0]]);
  const log = logs.find((l) => l.transactionHash === txs[0]);
  return { by: tx.from.toLowerCase(), via: tx.to?.toLowerCase() ?? null, txHash: txs[0], block: hi, timestamp: log.blockTimestamp ? num(log.blockTimestamp) : null };
}
