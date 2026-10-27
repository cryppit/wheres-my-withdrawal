// Reads everything verdict() needs for one OP Stack withdrawal (OP Mainnet, Base), starting from its L2 transaction hash.
// Every L1 read is pinned to the finalized block, so one answer never mixes two moments.
import { encodeCall, selector, topic, word, wordAt, uintAt, addressAt, boolAt, decodeBytes, decodeString, keccakHex, sameAddress } from "./abi.js";
import { PREDEPLOYS, FEE_VAULTS, SUPER_GAME_TYPES } from "./chains.js";

const MESSAGE_PASSED = topic("MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)");
const RELAY_MESSAGE = selector("relayMessage(uint256,address,address,uint256,uint256,bytes)");
const FINALIZE_ETH = selector("finalizeBridgeETH(address,address,uint256,bytes)");
const FINALIZE_ERC20 = selector("finalizeBridgeERC20(address,address,address,address,uint256,bytes)");

const num = (hex) => Number(BigInt(hex));

// Before OP Mainnet's Bedrock upgrade (6 June 2023) a withdrawal was only a SentMessage from the L2 messenger. The
// upgrade carried every one over into the new L2ToL1MessagePasser as a new-style withdrawal, built by
// op-chain-ops/crossdomain/migrate.go (v1.1.4, MigrateWithdrawal), which is what legacyWithdrawalsIn rebuilds.
const LEGACY_SENT_MESSAGE = topic("SentMessage(address,address,bytes,uint256,uint256)");
const LEGACY_FINALIZE_ETH = selector("finalizeETHWithdrawal(address,address,uint256,bytes)");
const LEGACY_FINALIZE_ERC20 = selector("finalizeERC20Withdrawal(address,address,address,address,uint256,bytes)");
const LEGACY_RELAY = selector("relayMessage(address,address,bytes,uint256)");
// migrate.go's overhead: RelayConstantOverhead + 64/63 of 1M (EIP-150) + RelayCallOverhead + RelayReservedGas + RelayGasCheckBuffer.
const MIGRATION_OVERHEAD = 200_000n + (64n * 1_000_000n) / 63n + 40_000n + 40_000n + 5_000n;

/** The gas limit the migration gave a withdrawal whose relayMessage data is `dataBytes` long (16 gas a byte), capped at 25M. */
export function migrationGasLimit(dataBytes) {
  const g = BigInt(dataBytes) * 16n + MIGRATION_OVERHEAD;
  return g > 25_000_000n ? 25_000_000n : g;
}

/** ABI-encode static words followed by one trailing `bytes` (its offset word sits after the static words). */
function withTrailingBytes(prefix, words, bytesHex) {
  const b = bytesHex.startsWith("0x") ? bytesHex.slice(2) : bytesHex;
  return prefix + words.map(word).join("") + word(BigInt(32 * (words.length + 1))) + word(BigInt(b.length / 2)) + b.padEnd(Math.ceil(b.length / 64) * 64, "0");
}

/** OP Mainnet only: the pre-Bedrock withdrawals in a receipt that has no MessagePassed log, rebuilt as migrated. */
export function legacyWithdrawalsIn(receipt, chain) {
  if (chain.id !== "op" || withdrawalsIn(receipt).length) return [];
  return receipt.logs
    .filter((l) => sameAddress(l.address, PREDEPLOYS.l2Messenger) && l.topics[0] === LEGACY_SENT_MESSAGE)
    .map((l) => {
      const target = "0x" + l.topics[1].slice(-40);
      const sender = addressAt(l.data, 0);
      const message = decodeBytes(l.data, 1);
      const nonce = uintAt(l.data, 2); // version 0: the migration kept the old nonce as it was
      // LegacyWithdrawal.Value: only an ETH withdrawal through the L2 standard bridge carries value.
      const value = sameAddress(sender, PREDEPLOYS.l2StandardBridge) && message.startsWith(LEGACY_FINALIZE_ETH) ? uintAt("0x" + message.slice(10), 2) : 0n;
      const data = withTrailingBytes(RELAY_MESSAGE, [nonce, sender, target, value, 0n], message);
      const gasLimit = migrationGasLimit((data.length - 2) / 2);
      const hash = keccakHex(withTrailingBytes("0x", [nonce, PREDEPLOYS.l2Messenger, chain.l1Messenger, value, gasLimit], data));
      // The L1 messenger marks a version-0 message relayed under its old hash, before or after the upgrade.
      const legacyHash = keccakHex(LEGACY_RELAY + word(target) + word(sender) + word(128n) + word(nonce) + word(BigInt((message.length - 2) / 2)) + message.slice(2).padEnd(Math.ceil((message.length - 2) / 64) * 64, "0"));
      return { nonce, sender: PREDEPLOYS.l2Messenger, target: chain.l1Messenger, value, gasLimit, data, hash, legacy: { sender, target, message, hash: legacyHash } };
    });
}

/** The withdrawals (MessagePassed logs) in an L2 receipt, in log order. */
export function withdrawalsIn(receipt) {
  return receipt.logs
    .filter((l) => sameAddress(l.address, PREDEPLOYS.messagePasser) && l.topics[0] === MESSAGE_PASSED)
    .map((l) => ({
      nonce: BigInt(l.topics[1]),
      sender: "0x" + l.topics[2].slice(-40),
      target: "0x" + l.topics[3].slice(-40),
      value: uintAt(l.data, 0),
      gasLimit: uintAt(l.data, 1),
      data: decodeBytes(l.data, 2),
      hash: "0x" + wordAt(l.data, 3),
    }));
}

/** What a withdrawal carries, when it goes through the standard bridge; a plain message otherwise. */
export function assetOf(w, chain) {
  if (!sameAddress(w.target, chain.l1Messenger)) return { kind: "eth", amount: w.value, to: w.target };
  if (!w.data.startsWith(RELAY_MESSAGE)) return { kind: "message", to: w.target };
  const args = "0x" + w.data.slice(10);
  const innerTarget = addressAt(args, 2);
  const message = decodeBytes(args, 5);
  if ([chain.l1StandardBridge, ...(chain.l1ExtraBridges ?? [])].some((b) => sameAddress(innerTarget, b))) {
    const m = "0x" + message.slice(10);
    if (message.startsWith(FINALIZE_ETH) || message.startsWith(LEGACY_FINALIZE_ETH)) return { kind: "eth", amount: uintAt(m, 2), from: addressAt(m, 0), to: addressAt(m, 1) };
    if (message.startsWith(LEGACY_FINALIZE_ERC20)) {
      return { kind: "erc20", l1Token: addressAt(m, 0), l2Token: addressAt(m, 1), from: addressAt(m, 2), to: addressAt(m, 3), amount: uintAt(m, 4) };
    }
    if (message.startsWith(FINALIZE_ERC20)) {
      return { kind: "erc20", l1Token: addressAt(m, 0), l2Token: addressAt(m, 1), from: addressAt(m, 2), to: addressAt(m, 3), amount: uintAt(m, 4) };
    }
  }
  return { kind: "message", amount: uintAt(args, 3), from: addressAt(args, 1), to: innerTarget };
}

export async function readFacts(chain, txHash, { l1, l2 }, { index = 0 } = {}) {
  const receipt = await l2("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { error: "not-found", message: `No ${chain.name} transaction with this hash.` };
  let all = withdrawalsIn(receipt);
  const legacy = !all.length && (all = legacyWithdrawalsIn(receipt, chain)).length > 0;
  if (!all.length) return { error: "not-a-withdrawal", message: `This ${chain.name} transaction does not start a withdrawal to Ethereum.` };
  const w = all[index];
  if (!w) return { error: "bad-index", message: `This transaction has ${all.length} withdrawal(s); there is no #${index}.` };
  if (legacy) {
    // The rebuilt hash must be in the L2ToL1MessagePasser, or this is not how the migration stored it.
    const stored = await l2("eth_call", [{ to: PREDEPLOYS.messagePasser, data: encodeCall("sentMessages(bytes32)", [w.hash]) }, "latest"]);
    if (!stored || stored.reverted || !boolAt(stored, 0)) {
      return { error: "legacy-not-found", message: "This withdrawal was started before OP Mainnet's Bedrock upgrade (June 2023), and its migrated form could not be found on OP Mainnet." };
    }
  }

  const block = await l2("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const asset = assetOf(w, chain);
  const fin = await l1("eth_getBlockByNumber", ["finalized", false]);
  const tag = fin.number;

  const view = async (to, sig, args = []) => {
    const r = await l1("eth_call", [{ to, data: encodeCall(sig, args) }, tag]);
    return r && r.reverted ? null : r;
  };
  const portal = chain.portal;
  const [asrHex, dgfHex, maturityHex, finalizedHex] = await Promise.all([
    view(portal, "anchorStateRegistry()"),
    view(portal, "disputeGameFactory()"),
    view(portal, "proofMaturityDelaySeconds()"),
    view(portal, "finalizedWithdrawals(bytes32)", [w.hash]),
  ]);
  const asr = addressAt(asrHex, 0);
  const dgf = addressAt(dgfHex, 0);
  const finalityHex = await view(asr, "disputeGameFinalityDelaySeconds()");

  const facts = {
    chain: chain.id,
    l2: { txHash, blockNumber: num(receipt.blockNumber), timestamp: num(block.timestamp), withdrawals: all.length, index },
    withdrawal: { hash: w.hash, nonce: w.nonce, sender: w.sender, target: w.target, value: w.value, gasLimit: w.gasLimit },
    asset,
    feeVault: FEE_VAULTS.some((v) => sameAddress(v, w.sender) || sameAddress(v, asset.from)),
    l1: { block: num(tag), timestamp: num(fin.timestamp) },
    config: { maturitySec: num(maturityHex), finalityDelaySec: num(finalityHex), cadenceSec: chain.cadenceSec },
    finalized: boolAt(finalizedHex, 0),
    relay: null,
    proofs: [],
    coverage: { covered: true },
    contracts: { portal, asr, dgf },
    legacy,
  };

  if (legacy) {
    // Relayed before the upgrade, or after it through the messenger: either way it is marked under the old hash.
    const relayed = await view(chain.l1Messenger, "successfulMessages(bytes32)", [w.legacy.hash]);
    if (boolAt(relayed, 0)) return { ...facts, finalized: true, relay: "ok" };
  }

  if (asset.kind === "erc20") {
    const [sym, dec] = await Promise.all([view(asset.l1Token, "symbol()"), view(asset.l1Token, "decimals()")]);
    asset.symbol = sym ? decodeString(sym) : null;
    asset.decimals = dec ? num("0x" + wordAt(dec, 0)) : null;
  }

  if (facts.finalized) {
    if (sameAddress(w.target, chain.l1Messenger)) {
      // For a messenger withdrawal the L1 message hash is the hash of the relayMessage calldata (message version 1).
      const msgHash = w.legacy ? w.legacy.hash : keccakHex(w.data);
      const [ok, failed] = await Promise.all([
        view(chain.l1Messenger, "successfulMessages(bytes32)", [msgHash]),
        view(chain.l1Messenger, "failedMessages(bytes32)", [msgHash]),
      ]);
      facts.relay = boolAt(ok, 0) ? "ok" : boolAt(failed, 0) ? "failed" : "unknown";
    } else facts.relay = "ok";
    return facts;
  }

  const count = num(await view(portal, "numProofSubmitters(bytes32)", [w.hash]));
  for (let i = 0; i < count; i++) {
    const submitter = addressAt(await view(portal, "proofSubmitters(bytes32,uint256)", [w.hash, BigInt(i)]), 0);
    const proven = await view(portal, "provenWithdrawals(bytes32,address)", [w.hash, submitter]);
    const game = await readGame(addressAt(proven, 0), asr, view);
    facts.proofs.push({ submitter, provenAt: num("0x" + wordAt(proven, 1)), game });
  }

  // Is there a game on L1 yet whose proposal includes this withdrawal's L2 block?
  const games = num(await view(dgf, "gameCount()"));
  const latest = await view(dgf, "gameAtIndex(uint256)", [BigInt(games - 1)]);
  const latestType = num("0x" + wordAt(latest, 0));
  const latestGame = addressAt(latest, 2);
  const seq = num(await view(latestGame, "l2SequenceNumber()"));
  const need = SUPER_GAME_TYPES.has(latestType) ? facts.l2.timestamp : facts.l2.blockNumber;
  facts.coverage = { covered: seq >= need, latestGameType: latestType, latestSequence: seq, needed: need };
  const clock = await view(latestGame, "maxClockDuration()");
  if (clock) facts.config.maxClockSec = num(clock);
  return facts;
}

async function readGame(address, asr, view) {
  const [created, resolved, status, type, proper, retired, blacklisted, valid, expected] = await Promise.all([
    view(address, "createdAt()"),
    view(address, "resolvedAt()"),
    view(address, "status()"),
    view(address, "gameType()"),
    view(asr, "isGameProper(address)", [address]),
    view(asr, "isGameRetired(address)", [address]),
    view(asr, "isGameBlacklisted(address)", [address]),
    view(asr, "isGameClaimValid(address)", [address]),
    view(address, "expectedResolution()"), // Base AggregateVerifier only
  ]);
  return {
    address,
    type: type ? num(type) : null,
    createdAt: num(created),
    resolvedAt: num(resolved),
    status: num(status),
    proper: boolAt(proper, 0),
    retired: boolAt(retired, 0),
    blacklisted: boolAt(blacklisted, 0),
    claimValid: boolAt(valid, 0),
    ...(expected ? { expectedResolution: num(expected) } : {}),
  };
}
