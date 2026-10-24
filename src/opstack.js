// Reads everything verdict() needs for one OP Stack withdrawal (OP Mainnet, Base), starting from its L2 transaction hash.
// Every L1 read is pinned to the finalized block, so one answer never mixes two moments.
import { encodeCall, selector, topic, wordAt, uintAt, addressAt, boolAt, decodeBytes, keccakHex, sameAddress } from "./abi.js";
import { PREDEPLOYS, FEE_VAULTS, SUPER_GAME_TYPES } from "./chains.js";

const MESSAGE_PASSED = topic("MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)");
const RELAY_MESSAGE = selector("relayMessage(uint256,address,address,uint256,uint256,bytes)");
const FINALIZE_ETH = selector("finalizeBridgeETH(address,address,uint256,bytes)");
const FINALIZE_ERC20 = selector("finalizeBridgeERC20(address,address,address,address,uint256,bytes)");

const num = (hex) => Number(BigInt(hex));

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
  if (sameAddress(innerTarget, chain.l1StandardBridge)) {
    const m = "0x" + message.slice(10);
    if (message.startsWith(FINALIZE_ETH)) return { kind: "eth", amount: uintAt(m, 2), from: addressAt(m, 0), to: addressAt(m, 1) };
    if (message.startsWith(FINALIZE_ERC20)) {
      return { kind: "erc20", l1Token: addressAt(m, 0), l2Token: addressAt(m, 1), from: addressAt(m, 2), to: addressAt(m, 3), amount: uintAt(m, 4) };
    }
  }
  return { kind: "message", amount: uintAt(args, 3), from: addressAt(args, 1), to: innerTarget };
}

export async function readFacts(chain, txHash, { l1, l2 }, { index = 0 } = {}) {
  const receipt = await l2("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { error: "not-found", message: `No ${chain.name} transaction with this hash.` };
  const all = withdrawalsIn(receipt);
  if (!all.length) return { error: "not-a-withdrawal", message: `This ${chain.name} transaction does not start a withdrawal to Ethereum.` };
  const w = all[index];
  if (!w) return { error: "bad-index", message: `This transaction has ${all.length} withdrawal(s); there is no #${index}.` };

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
  };

  if (asset.kind === "erc20") {
    const [sym, dec] = await Promise.all([view(asset.l1Token, "symbol()"), view(asset.l1Token, "decimals()")]);
    asset.symbol = sym ? decodeString(sym) : null;
    asset.decimals = dec ? num("0x" + wordAt(dec, 0)) : null;
  }

  if (facts.finalized) {
    if (sameAddress(w.target, chain.l1Messenger)) {
      // For a messenger withdrawal the L1 message hash is the hash of the relayMessage calldata (message version 1).
      const msgHash = keccakHex(w.data);
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

function decodeString(hex) {
  try {
    const raw = decodeBytes(hex, 0).slice(2);
    return new TextDecoder().decode(Uint8Array.from(raw.match(/.{2}/g) ?? [], (b) => parseInt(b, 16)));
  } catch {
    return null;
  }
}
