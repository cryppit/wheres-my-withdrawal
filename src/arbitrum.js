// Reads everything verdict() needs for one Arbitrum One withdrawal, starting from its L2 transaction hash.
// The flow (arbitrum-sdk ChildToParentMessageNitro, nitro-contracts AbsOutbox and BoLD RollupCore): ArbSys emits
// L2ToL1Tx with a `position`; the claim opens once a confirmed assertion's L2 block has sendCount > position; anyone
// then calls Outbox.executeTransaction, and Outbox.isSpent(position) turns true. L1 reads are pinned to the finalized
// block, like the OP reader.
import { encodeCall, selector, topic, word, wordAt, uintAt, addressAt, boolAt, decodeBytes, decodeString, decodeWords, sameAddress } from "./abi.js";
import { ARBITRUM } from "./chains.js";
import { inBatches } from "./rpc.js";

const L2_TO_L1_TX = topic("L2ToL1Tx(address,address,uint256,uint256,uint256,uint256,uint256,uint256,bytes)");
const CLASSIC_L2_TO_L1 = topic("L2ToL1Transaction(address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes)");
// AssertionInputs is all static, so the log data is 25 words: the after-state block hash is word 13 and the
// confirm period that governs this assertion (the parent's config, as confirmAssertion checks it) is word 5.
const ASSERTION_CREATED = topic(
  "AssertionCreated(bytes32,bytes32,((bytes32,bytes32,(bytes32,uint256,address,uint64,uint64)),((bytes32[2],uint64[2]),uint8,bytes32),((bytes32[2],uint64[2]),uint8,bytes32)),bytes32,uint256,bytes32,uint256,address,uint64)",
);
const ASSERTION_CONFIRMED = topic("AssertionConfirmed(bytes32,bytes32,bytes32)");
const OUTBOX_EXECUTED = topic("OutBoxTransactionExecuted(address,address,uint256,uint256)");
const FINALIZE_INBOUND = selector("finalizeInboundTransfer(address,address,address,uint256,bytes)");

const L1_BLOCK_SEC = 12;
const num = (hex) => Number(BigInt(hex));
const hex = (n) => "0x" + BigInt(n).toString(16);

/** The withdrawals (ArbSys L2ToL1Tx logs) in an L2 receipt, in log order. */
export function withdrawalsIn(receipt) {
  return receipt.logs
    .filter((l) => sameAddress(l.address, ARBITRUM.arbSys) && l.topics[0] === L2_TO_L1_TX)
    .map((l) => ({
      hash: "0x" + l.topics[2].slice(2),
      position: num(l.topics[3]),
      sender: addressAt(l.data, 0),
      target: "0x" + l.topics[1].slice(-40),
      arbBlockNum: num("0x" + wordAt(l.data, 1)),
      ethBlockNum: num("0x" + wordAt(l.data, 2)),
      timestamp: num("0x" + wordAt(l.data, 3)),
      value: uintAt(l.data, 4),
      data: decodeBytes(l.data, 5),
    }));
}

/**
 * What a withdrawal carries, from the log alone. Plain ETH (ArbSys.withdrawEth) has empty data. A token gateway
 * withdrawal calls finalizeInboundTransfer(token, from, to, amount, data) on the L1 gateway; readFacts only keeps that
 * label after checking the gateway on L1, because any contract can send this calldata.
 */
export function assetOf(w) {
  if (w.data === "0x") return { kind: "eth", amount: w.value, from: w.sender, to: w.target };
  if (w.data.startsWith(FINALIZE_INBOUND)) {
    const a = "0x" + w.data.slice(10);
    return { kind: "erc20", l1Token: addressAt(a, 0), from: addressAt(a, 1), to: addressAt(a, 2), amount: uintAt(a, 3), gateway: w.target };
  }
  return message(w);
}

const message = (w) => ({ kind: "message", amount: w.value, from: w.sender, to: w.target });

/**
 * `clients.l1Archive` serves old state and wide log ranges (MEV Blocker, Tenderly); it defaults to `l1`.
 * With `deferClaim`, a spent withdrawal comes back with claimLookup "pending" and no history search: claimOf() fills
 * in the claimer afterwards, so the page can show the verdict first.
 */
export async function readFacts(chain, txHash, { l1, l2, l1Archive = l1 }, { index = 0, deferClaim = false } = {}) {
  const receipt = await l2("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { error: "not-found", message: `No ${chain.name} transaction with this hash.` };
  const all = withdrawalsIn(receipt);
  if (!all.length) {
    if (receipt.logs.some((l) => sameAddress(l.address, ARBITRUM.arbSys) && l.topics[0] === CLASSIC_L2_TO_L1)) {
      return { error: "unsupported", message: "This is an Arbitrum Classic withdrawal (before the Nitro upgrade of 31 Aug 2022). Only Nitro withdrawals are supported." };
    }
    return { error: "not-a-withdrawal", message: `This ${chain.name} transaction does not start a withdrawal to Ethereum.` };
  }
  const w = all[index];
  if (!w) return { error: "bad-index", message: `This transaction has ${all.length} withdrawal(s); there is no #${index}.` };

  const fin = await l1("eth_getBlockByNumber", ["finalized", false]);
  const tag = fin.number;
  const finBlock = num(tag);
  const view = async (to, sig, args = [], block = tag) => {
    const r = await l1("eth_call", [{ to, data: encodeCall(sig, args) }, block]);
    return r && r.reverted ? null : r;
  };

  // Every read that does not depend on another goes out together: each round trip to a public RPC costs ~300 ms.
  const rollup = chain.rollup;
  const [outboxHex, latestHex, periodHex, openHex, asset] = await Promise.all([
    view(rollup, "outbox()"),
    view(rollup, "latestConfirmed()"),
    view(rollup, "confirmPeriodBlocks()"),
    view(rollup, "validatorWhitelistDisabled()"),
    checkedAsset(w, chain, view),
  ]);
  const outbox = addressAt(outboxHex, 0);
  const latest = "0x" + wordAt(latestHex, 0);
  // Started now, needed only if the withdrawal is not spent; a spent one never waits on it.
  const confirmedHash = confirmedBlockHash(latest, rollup, finBlock, l1, l1Archive, view);
  confirmedHash.catch(() => {});
  const spentHex = await view(outbox, "isSpent(uint256)", [BigInt(w.position)]);

  const facts = {
    chain: chain.id,
    stack: "arbitrum",
    l2: { txHash, blockNumber: num(receipt.blockNumber), timestamp: w.timestamp, withdrawals: all.length, index },
    withdrawal: w,
    asset,
    feeVault: false,
    l1: { block: finBlock, timestamp: num(fin.timestamp) },
    config: { confirmPeriodBlocks: num(periodHex), l1BlockSec: L1_BLOCK_SEC, cadenceSec: chain.cadenceSec, anyoneCanConfirm: boolAt(openHex, 0) },
    spent: boolAt(spentHex, 0),
    claim: null,
    claimLookup: null,
    confirmed: null,
    covering: null,
    proof: null,
    contracts: { rollup, outbox },
  };

  if (facts.spent) {
    if (deferClaim) facts.claimLookup = "pending";
    else Object.assign(facts, await claimOf(facts, { l1, l1Archive }));
    return facts;
  }

  // The latest confirmed assertion and the sendCount of its L2 block.
  const l2Block = await l2("eth_getBlockByHash", [await confirmedHash, false]);
  const sendCount = num(l2Block.sendCount);
  facts.confirmed = { assertion: latest, l2Block: num(l2Block.number), sendCount, covered: sendCount > w.position };

  if (facts.confirmed.covered) {
    facts.proof = await outboxProof(w, sendCount, outbox, l2, view);
    return facts;
  }
  facts.covering = await coveringAssertion(w, rollup, finBlock, l1, l1Archive, l2);
  return facts;
}

/**
 * Who sent the claim of a spent withdrawal: { claim, claimLookup }. claimLookup is null when found, "not-found" when
 * the search ended without the log, "failed" when no endpoint served the history. It never guesses.
 */
export async function claimOf(facts, { l1, l1Archive = l1 }) {
  const w = facts.withdrawal;
  try {
    const claim = await findClaim(w, facts.contracts.outbox, w.ethBlockNum + facts.config.confirmPeriodBlocks, facts.l1.block, l1Archive);
    return { claim, claimLookup: claim ? null : "not-found" };
  } catch {
    return { claim: null, claimLookup: "failed" }; // no archive state or logs from the free endpoints; the verdict says so
  }
}

/** Keep the ERC-20 label only for a real gateway: the router must map the token to it, and its L2 counterpart must be the sender. */
async function checkedAsset(w, chain, view) {
  const a = assetOf(w);
  if (a.kind !== "erc20") return a;
  const [gw, counterpart] = await Promise.all([
    view(chain.l1GatewayRouter, "getGateway(address)", [a.l1Token]),
    view(w.target, "counterpartGateway()"),
  ]);
  if (!gw || !counterpart || !sameAddress(addressAt(gw, 0), w.target) || !sameAddress(addressAt(counterpart, 0), w.sender)) return message(w);
  const [sym, dec] = await Promise.all([view(a.l1Token, "symbol()"), view(a.l1Token, "decimals()")]);
  a.symbol = sym ? decodeString(sym) : null;
  a.decimals = dec ? num("0x" + wordAt(dec, 0)) : null;
  return a;
}

/**
 * The L2 block hash of a confirmed assertion. AssertionConfirmed carries it and is recent (confirmations come about
 * hourly), so a short window stays inside PublicNode's free log range. If confirmations have stalled, fall back to the
 * AssertionCreated log at the assertion's creation block, about 6.4 days back, which needs an archive endpoint.
 */
async function confirmedBlockHash(assertion, rollup, finBlock, l1, archive, view) {
  const recent = await l1("eth_getLogs", [{ address: rollup, fromBlock: hex(finBlock - 1799), toBlock: hex(finBlock), topics: [ASSERTION_CONFIRMED, assertion] }]);
  if (recent.length) return "0x" + wordAt(recent[recent.length - 1].data, 0);
  const node = await view(rollup, "getAssertion(bytes32)", [assertion]);
  const created = hex(uintAt(node, 2)); // AssertionNode: firstChildBlock, secondChildBlock, createdAtBlock, ...
  const logs = await archive("eth_getLogs", [{ address: rollup, fromBlock: created, toBlock: created, topics: [ASSERTION_CREATED, assertion] }]);
  if (!logs.length) throw new Error(`AssertionCreated for ${assertion} not found`);
  return "0x" + wordAt(logs[0].data, 13);
}

// PublicNode's free tier serves logs from roughly the last 10,000 L1 blocks; older ranges go straight to an archive
// endpoint instead of failing there first.
const RECENT_BLOCKS = 8000;

/**
 * The first assertion whose L2 block includes this withdrawal, and when its challenge window ends. The search starts
 * at the L1 block the withdrawal saw (no earlier assertion can include it) and widens until the finalized block.
 * Returns null when no assertion includes it yet. Rival assertions are not told apart: the first one wins here.
 */
async function coveringAssertion(w, rollup, finBlock, l1, archive, l2) {
  let from = w.ethBlockNum;
  for (let size = 1000; from <= finBlock; size *= 2) {
    const to = Math.min(finBlock, from + size - 1);
    const logs = await (from < finBlock - RECENT_BLOCKS ? archive : l1)("eth_getLogs", [{ address: rollup, fromBlock: hex(from), toBlock: hex(to), topics: [ASSERTION_CREATED] }]);
    // About one assertion an hour: read their L2 blocks eight at a time (arb1 rate limits bursts), first in order wins.
    for (let k = 0; k < logs.length; k += 8) {
      const batch = logs.slice(k, k + 8);
      const blocks = await Promise.all(batch.map((log) => l2("eth_getBlockByHash", ["0x" + wordAt(log.data, 13), false])));
      const i = blocks.findIndex((b) => b && num(b.sendCount) > w.position);
      if (i >= 0) {
        const createdAtBlock = num(batch[i].blockNumber);
        return { assertion: batch[i].topics[1], createdAtBlock, deadlineBlock: createdAtBlock + num("0x" + wordAt(batch[i].data, 5)) };
      }
    }
    from = to + 1;
  }
  return null;
}

/**
 * The Merkle proof for the claim, from NodeInterface on L2, checked two ways: its leaf must be this withdrawal's
 * hash, and its root must be one the Outbox already accepts (Outbox.roots(root) is the L2 block hash, or zero).
 */
async function outboxProof(w, size, outbox, l2, view) {
  const r = await l2("eth_call", [{ to: ARBITRUM.nodeInterface, data: encodeCall("constructOutboxProof(uint64,uint64)", [BigInt(size), BigInt(w.position)]) }, "latest"]);
  const words = decodeWords(r);
  const at = Number(BigInt("0x" + words[2])) / 32;
  const hashes = words.slice(at + 1, at + 1 + Number(BigInt("0x" + words[at]))).map((x) => "0x" + x);
  const leaf = "0x" + words[0];
  const root = "0x" + words[1];
  const known = await view(outbox, "roots(bytes32)", [root]);
  return { size, leaf, root, hashes, leafMatches: leaf === w.hash, rootConfirmed: !!known && uintAt(known, 0) !== 0n };
}

// MEV Blocker answers eth_getLogs of any size up to this many blocks; about 1.4 days of L1, so even the standard
// gateway (a few claims an hour share its `to` and `l2Sender` topics) returns a small page.
const LOG_SPAN = 10_000;
const PROBES = 15;

/**
 * Who sent the claim. The Outbox keeps no record of it, but every claim emits OutBoxTransactionExecuted(to, l2Sender,
 * 0, transactionIndex) with transactionIndex = position, and a position can be spent only once. The claim lies between
 * the withdrawal's L1 block plus one confirm period (it cannot come sooner) and the finalized block. Most claims come
 * right when the window opens, or recently from third parties finishing old withdrawals, so the first round reads
 * the logs at both ends; meanwhile isSpent(position) on historical state at 15 points narrows the range 16-fold per
 * round until it fits one log query. Both need an archive endpoint.
 */
async function findClaim(w, outbox, earliest, finBlock, archive) {
  const topics = [OUTBOX_EXECUTED, "0x" + word(w.target), "0x" + word(w.sender)];
  const claimIn = async (from, to) => {
    const logs = await archive("eth_getLogs", [{ address: outbox, fromBlock: hex(from), toBlock: hex(to), topics }]);
    return logs.find((l) => uintAt(l.data, 0) === BigInt(w.position)) ?? null;
  };
  const spentAt = async (b) => boolAt(await archive("eth_call", [{ to: outbox, data: encodeCall("isSpent(uint256)", [BigInt(w.position)]) }, hex(b)]), 0);

  let lo = Math.min(earliest, finBlock);
  let hi = finBlock; // spent here; the claim's block is in [lo, hi]
  let log = null;
  for (let round = 0; !log && hi - lo + 1 > LOG_SPAN; round++) {
    const probes = [...new Set(Array.from({ length: PROBES }, (_, i) => lo + Math.floor(((hi - lo) * (i + 1)) / (PROBES + 1))))].filter((p) => p < hi);
    const ends = round === 0 ? [claimIn(lo, lo + LOG_SPAN - 1), claimIn(hi - LOG_SPAN + 1, hi)].map((p) => p.catch(() => null)) : [];
    const [spent, found] = await Promise.all([inBatches(probes, spentAt), Promise.all(ends)]);
    log = found.find(Boolean) ?? null;
    const first = spent.indexOf(true);
    if (first >= 0) {
      hi = probes[first];
      if (first > 0) lo = probes[first - 1] + 1;
    } else lo = probes[probes.length - 1] + 1;
  }
  log ??= await claimIn(lo, hi);
  if (!log) return null;
  const tx = await archive("eth_getTransactionByHash", [log.transactionHash]);
  return { by: tx.from.toLowerCase(), txHash: log.transactionHash, block: num(log.blockNumber), timestamp: log.blockTimestamp ? num(log.blockTimestamp) : null };
}
