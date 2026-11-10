// Reads everything verdict() needs for one Taiko withdrawal, starting from its L2 transaction hash.
//
// Taiko Alethia (mainnet L2 chainId 167000, gas token ETH) is a BASED validity rollup on a SignalService + Bridge —
// its own family, NOT OP Stack, NOT Scroll-style, NOT the LxLy bridge. A withdrawal is a `MessageSent(bytes32 msgHash,
// Message message)` log from the L2 Bridge (0x1670…0001) with destChainId == 1 (to Ethereum). Sending the message
// stored a SIGNAL in the L2 SignalService (0x1670…0005): the slot getSignalSlot(167000, L2Bridge, msgHash) now holds
// msgHash. TaikoInbox (TaikoL1, 0x06a9…b19a) proves each L2 batch with a validity proof and SYNCS the proven L2 state
// root to the L1 SignalService (0x9e0a…C77C) as a checkpoint — there is NO fault-proof challenge delay. To claim, the
// user calls Bridge.processMessage(Message, bytes proof) on the L1 Bridge (0xd602…d8EC); `proof` is abi.encode of one
// HopProof carrying (blockId, rootHash, accountProof, storageProof). On L1 the SignalService requires
// getCheckpoint(blockId).stateRoot == proof.rootHash, then LibTrieProof verifies the account+storage proof of the
// signal slot against that synced state root. The message is done when Bridge.messageStatus(msgHash) == DONE (2).
//
// The signal proof is a plain Merkle-Patricia proof of an L2 storage slot, so it is reconstructable KEYLESS from the
// browser via eth_getProof — no bridge API. So this reader builds the FULL processMessage claim: it reads the latest
// synced checkpoint from L1 (the CheckpointSaved events + getCheckpoint), pulls eth_getProof of the signal slot on L2
// at that synced block, and trusts it only after re-folding BOTH legs on chain — the storage proof to the signal
// slot's value (== msgHash) and the account proof to the checkpoint's state root (the root TaikoInbox synced to L1).
// That synced-root re-fold is the guard: `finalized` is never set unless the proof folds to a state root L1 holds.
//
// Everything below — every address, the Message struct and msgHash encoding (keccak256(abi.encode("TAIKO_MESSAGE",
// message))), the MessageSent / MessageStatusChanged / CheckpointSaved events, the getSignalSlot derivation
// (keccak256(abi.encodePacked("SIGNAL", uint64 chainId, address app, bytes32 signal))), the processMessage selector
// (0x2035065e), the HopProof layout, getCheckpoint(uint48) and the Status enum — was verified on chain on 10 Nov 2026
// against a real claimed withdrawal (see test/taiko.test.js and src/chains.js).
//
// Stages: initiated (MessageSent, not yet synced) -> waiting for the L2 state root to be synced to L1 (no synced
// checkpoint covers the block yet) -> claimable (a checkpoint covers it and the signal proof folds to its synced
// state root; FULL claim built) -> claimed (messageStatus == DONE). All L1 reads are pinned to the finalized L1 block.
import { encodeCall, topic, wordAt, uintAt, keccakHex, sameAddress } from "./abi.js";
import { verifyMerkleProof, rlpList, rlpBytes } from "./trie.js";

const MSG_TUPLE = "(uint64,uint64,uint32,address,uint64,address,uint64,address,address,uint256,bytes)";
const MESSAGE_SENT = topic(`MessageSent(bytes32,${MSG_TUPLE})`);
const MESSAGE_STATUS_CHANGED = topic("MessageStatusChanged(bytes32,uint8)");
const CHECKPOINT_SAVED = topic("CheckpointSaved(uint48,bytes32,bytes32)");

// IBridge.Status: the done flag for a withdrawal is DONE (2).
const STATUS = { NEW: 0, RETRIABLE: 1, DONE: 2, FAILED: 3, RECALLED: 4 };
const MAINNET = 1n; // withdrawals to Ethereum carry destChainId == 1
const L1_BLOCK_SEC = 12;
// How far back to look for synced checkpoints. Taiko syncs one about every 30 minutes (~150 L1 blocks); 4000 L1 blocks
// (~13 h) always holds several, and the newest of them is the deepest L2 block L1 has a state root for.
const CHECKPOINT_WINDOW = 4000;

const num = (hex) => Number(BigInt(hex));
const hex = (n) => "0x" + BigInt(n).toString(16);
const strip = (h) => h.replace(/^0x/, "").toLowerCase();
const uintWord = (v) => BigInt(v).toString(16).padStart(64, "0");

/** One 32-byte ABI word for a bigint/number/address/bytes32. */
const W = (v) => (typeof v === "bigint" || typeof v === "number" ? BigInt(v).toString(16).padStart(64, "0") : strip(v).padStart(64, "0"));

/**
 * ABI-encode the Bridge.Message tuple (10 static fields then one dynamic `bytes data`), as abi.encode(message) does
 * once its leading pointer is stripped. Shared by the msgHash and by the processMessage claim, so they can never drift.
 */
export function encodeMessageTuple(m) {
  const b = strip(m.data);
  const head =
    W(m.id) + W(m.fee) + W(m.gasLimit) + W(m.from) + W(m.srcChainId) + W(m.srcOwner) +
    W(m.destChainId) + W(m.destOwner) + W(m.to) + W(m.value) + W(11n * 32n);
  const tail = uintWord(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, "0");
  return head + tail;
}

const TAIKO_MESSAGE_HEX = "5441494b4f5f4d455353414745"; // "TAIKO_MESSAGE" in ASCII, 13 bytes
const SIGNAL_HEX = "5349474e414c"; // "SIGNAL" in ASCII, 6 bytes
/** Decode a hex byte string to UTF-8 (browser-safe; no Node Buffer). */
function hexToUtf8(hex) {
  const s = strip(hex);
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return new TextDecoder().decode(b);
}

/** msgHash = keccak256(abi.encode("TAIKO_MESSAGE", message)) — Bridge.hashMessage, confirmed on chain. */
export function messageHash(m) {
  const strEnc = W(13n) + TAIKO_MESSAGE_HEX.padEnd(64, "0");
  const tupleEnc = encodeMessageTuple(m);
  const offStr = 0x40;
  const offTuple = offStr + strEnc.length / 2;
  return keccakHex("0x" + W(BigInt(offStr)) + W(BigInt(offTuple)) + strEnc + tupleEnc);
}

/** getSignalSlot(chainId, app, signal) = keccak256(abi.encodePacked("SIGNAL", uint64 chainId, address app, bytes32 signal)). */
export function signalSlot(chainId, app, signal) {
  return keccakHex("0x" + SIGNAL_HEX + BigInt(chainId).toString(16).padStart(16, "0") + strip(app) + strip(signal));
}

/** Decode a Message from a MessageSent log's data (a single dynamic tuple: word 0 is the pointer 0x20). */
function decodeMessage(data) {
  const o = 1; // skip the tuple pointer word
  const u = (i) => uintAt(data, o + i);
  const a = (i) => "0x" + wordAt(data, o + i).slice(24);
  // field 10 (data) is a pointer relative to the tuple start (which begins at word 1, i.e. byte 32).
  const inner = relBytes(data, 32, uintAt(data, o + 10));
  return { id: u(0), fee: u(1), gasLimit: u(2), from: a(3), srcChainId: u(4), srcOwner: a(5), destChainId: u(6), destOwner: a(7), to: a(8), value: u(9), data: inner };
}

/** The `bytes` whose length/value sit at absolute byte offset `base + rel` in `hex`. */
function relBytes(hex, base, rel) {
  const s = strip(hex);
  const at = (base + Number(rel)) * 2;
  const len = parseInt(s.slice(at, at + 64), 16) * 2;
  return "0x" + s.slice(at + 64, at + 64 + len);
}

/** The withdrawals (MessageSent logs from the L2 Bridge with destChainId == 1) in an L2 receipt, in log order. */
export function withdrawalsIn(receipt, chain) {
  return receipt.logs
    .filter((l) => sameAddress(l.address, chain.l2Bridge) && l.topics[0] === MESSAGE_SENT)
    .map((l) => {
      const message = decodeMessage(l.data);
      const hash = messageHash(message);
      return { message, hash, eventHash: l.topics[1].toLowerCase(), slot: signalSlot(message.srcChainId, chain.l2Bridge, hash) };
    })
    .filter((w) => w.message.destChainId === MAINNET);
}

const L1_ERC20_VAULT = "0x996282ca11e5deb6b5d122cc3b9a1fcaad4415ab"; // Taiko L1 ERC20Vault (message.to for token withdrawals)
const ON_MESSAGE_INVOCATION = "0x7f07c947"; // onMessageInvocation(bytes)

/**
 * What a withdrawal carries. An empty `data` is a plain ETH transfer to the message's `to`. A call to the L1
 * ERC20Vault's onMessageInvocation is a token: its argument abi.encodes (CanonicalERC20 token, address from, address
 * to, uint256 amount), and CanonicalERC20 carries the token's chainId, address, decimals and symbol, so no token read
 * is needed. Anything else is reported as a generic message (never guessed).
 */
export function assetOf(message) {
  const data = strip(message.data);
  if (data.length === 0) return { kind: "eth", amount: message.value, to: message.to, from: message.from };
  if (sameAddress(message.to, L1_ERC20_VAULT) && message.data.startsWith(ON_MESSAGE_INVOCATION)) {
    try {
      // onMessageInvocation(bytes): [selector][offset][len][payload]; payload = (CanonicalERC20, from, to, amount).
      const arg = data.slice(8); // after selector
      const payLen = parseInt(arg.slice(64, 128), 16) * 2;
      const pay = arg.slice(128, 128 + payLen);
      const pw = (i) => pay.slice(i * 64, (i + 1) * 64);
      const from = "0x" + pw(1).slice(24);
      const to = "0x" + pw(2).slice(24);
      const amount = BigInt("0x" + pw(3));
      const sOff = parseInt(pw(0), 16) * 2; // offset to the CanonicalERC20 struct
      const sw = (i) => pay.slice(sOff + i * 64, sOff + (i + 1) * 64);
      const tokenChainId = Number(BigInt("0x" + sw(0)));
      const tokenAddr = "0x" + sw(1).slice(24);
      const decimals = Number(BigInt("0x" + sw(2)));
      const symAt = sOff + parseInt(sw(3), 16) * 2;
      const symLen = parseInt(pay.slice(symAt, symAt + 64), 16) * 2;
      const symbol = hexToUtf8(pay.slice(symAt + 64, symAt + 64 + symLen)) || null;
      return { kind: "erc20", l1Token: tokenChainId === 1 ? tokenAddr : null, l2Token: tokenChainId === 1 ? null : tokenAddr, tokenChainId, symbol, decimals, from, to, amount };
    } catch {
      return { kind: "message", amount: message.value, from: message.from, to: message.to };
    }
  }
  return { kind: "message", amount: message.value, from: message.from, to: message.to };
}

/** The latest synced checkpoint (greatest L2 blockNumber) in the CheckpointSaved events up to the finalized L1 block. */
async function latestCheckpoint(chain, l1, finBlock, view) {
  const from = Math.max(0, finBlock - CHECKPOINT_WINDOW);
  const logs = await l1("eth_getLogs", [{ address: chain.l1SignalService, fromBlock: hex(from), toBlock: hex(finBlock), topics: [CHECKPOINT_SAVED] }]);
  let best = null;
  for (const l of logs) {
    const blockNumber = num(l.topics[1]); // uint48 blockNumber, indexed
    if (!best || blockNumber > best.blockNumber) best = { blockNumber, stateRoot: "0x" + l.data.slice(66, 130) };
  }
  if (!best) return null;
  // Read the authoritative state root from getCheckpoint, pinned to the finalized block (the event only pointed us at it).
  const cp = await view(chain.l1SignalService, "getCheckpoint(uint48)", [BigInt(best.blockNumber)]);
  if (!cp) return best;
  return { blockNumber: num("0x" + wordAt(cp, 0)), blockHash: "0x" + wordAt(cp, 1), stateRoot: "0x" + wordAt(cp, 2) };
}

/**
 * Build the signal proof against a synced checkpoint and re-verify it entirely on chain. Pulls eth_getProof of the
 * signal slot on L2 at the checkpoint's block, then folds BOTH legs (LibTrieProof's own check): the storage proof to
 * the slot's value (which must be the msgHash) and the account proof to the checkpoint's state root (the root L1 holds).
 * rootConfirmed is true only when both folds hold against that synced root — never the RPC's word.
 */
async function proveSignal(chain, w, cp, l2) {
  const gp = await l2("eth_getProof", [chain.l2SignalService, [w.slot], hex(cp.blockNumber)]);
  const sp = gp.storageProof?.[0];
  if (!sp) return null;
  const signalPresent = BigInt(sp.value || "0x0") === BigInt(w.hash);
  // Storage leg: the proof must fold to the account's storage root and yield RLP(msgHash) at the slot.
  const storage = verifyMerkleProof(gp.storageHash, w.slot, sp.proof);
  const storageValue = storage.ok ? "0x" + strip(rlpBytes(storage.value)).padStart(64, "0") : null;
  const storageOk = storage.ok && storageValue != null && BigInt(storageValue) === BigInt(w.hash);
  // Account leg: the proof must fold to the checkpoint's SYNCED state root and name a storage root equal to the one above.
  const account = verifyMerkleProof(cp.stateRoot, chain.l2SignalService, gp.accountProof);
  const accountStorageRoot = account.ok ? accountStorageRootOf(account.value) : null;
  const accountOk = account.ok && accountStorageRoot != null && sameAddress(accountStorageRoot, gp.storageHash);
  const rootConfirmed = !!(signalPresent && storageOk && accountOk);
  return {
    blockId: cp.blockNumber,
    rootHash: cp.stateRoot,
    accountProof: gp.accountProof,
    storageProof: sp.proof,
    storageHash: gp.storageHash,
    signalPresent,
    storageConfirmed: storageOk,
    accountConfirmed: accountOk,
    rootConfirmed,
    hashes: [...gp.accountProof, ...sp.proof],
  };
}

/** The storage root (3rd field) of an RLP-encoded account [nonce, balance, storageRoot, codeHash]; rlpList already decodes each field. */
function accountStorageRootOf(rlpHex) {
  const items = rlpList(rlpHex);
  return Array.isArray(items) && items.length === 4 ? "0x" + strip(items[2]).padStart(64, "0") : null;
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

  const statusHex = await view(chain.l1Bridge, "messageStatus(bytes32)", [w.hash]);
  const status = statusHex ? num("0x" + wordAt(statusHex, 0)) : null;
  const asset = assetOf(w.message);

  const facts = {
    chain: chain.id,
    stack: "taiko",
    l2: { txHash, blockNumber: l2Block, timestamp: num(block.timestamp), withdrawals: all.length, index },
    withdrawal: { hash: w.hash, slot: w.slot, message: w.message },
    asset,
    feeVault: false,
    hashVerified: w.hash.toLowerCase() === w.eventHash, // recomputed msgHash matches the event's own topic
    l1: { block: finBlock, timestamp: num(fin.timestamp) },
    status,
    finalized: false,
    claimed: status === STATUS.DONE,
    checkpoint: null,
    proof: null,
    proofLookup: null,
    claim: null,
    claimLookup: null,
    contracts: { l1Bridge: chain.l1Bridge, l1SignalService: chain.l1SignalService, taikoInbox: chain.taikoInbox, l2Bridge: chain.l2Bridge, l2SignalService: chain.l2SignalService },
  };

  if (facts.claimed) {
    facts.finalized = true;
    // Who sent the claim: the MessageStatusChanged(msgHash, DONE) log on the L1 Bridge, and its transaction's sender.
    const fromBlock = Math.max(0, finBlock - Math.ceil((facts.l1.timestamp - facts.l2.timestamp) / L1_BLOCK_SEC) - 1000);
    try {
      facts.claim = await findClaim(w, chain.l1Bridge, fromBlock, finBlock, l1Archive);
      if (!facts.claim) facts.claimLookup = "not-found";
    } catch {
      facts.claimLookup = "failed";
    }
    return facts;
  }

  // A message that was delivered but is RETRIABLE/FAILED/RECALLED is not a clean claimable withdrawal: it is handled
  // from its status alone (the verdict), and we never build a processMessage claim for it. Only a NEW message is proved.
  if (status !== STATUS.NEW) return facts;

  // Not done yet. Find the latest L2 state root L1 has synced, then prove the signal against it.
  let cp = null;
  try {
    cp = await latestCheckpoint(chain, l1, finBlock, view);
  } catch {
    facts.proofLookup = "failed";
    return facts;
  }
  if (!cp) {
    facts.proofLookup = "no-checkpoint";
    return facts;
  }
  facts.checkpoint = { blockNumber: cp.blockNumber, stateRoot: cp.stateRoot, coversWithdrawal: cp.blockNumber >= l2Block };
  if (cp.blockNumber < l2Block) return facts; // no synced state root reaches this withdrawal yet -> waiting

  try {
    const p = await proveSignal(chain, w, cp, l2);
    facts.proof = p;
    // Claimable only when the signal proof folds to the state root L1 synced for this checkpoint.
    facts.finalized = !!p && p.rootConfirmed;
  } catch {
    facts.proofLookup = "failed";
  }
  return facts;
}

/** Who sent the claim: the MessageStatusChanged log that set this msgHash to DONE, and its transaction's sender. */
async function findClaim(w, l1Bridge, from, finBlock, l1) {
  const logs = await l1("eth_getLogs", [{ address: l1Bridge, fromBlock: hex(from), toBlock: hex(finBlock), topics: [MESSAGE_STATUS_CHANGED, w.hash] }]);
  const done = logs.filter((l) => num("0x" + wordAt(l.data, 0)) === STATUS.DONE);
  if (!done.length) return null;
  const log = done[done.length - 1];
  const tx = await l1("eth_getTransactionByHash", [log.transactionHash]);
  return { by: tx.from.toLowerCase(), txHash: log.transactionHash, block: num(log.blockNumber), timestamp: log.blockTimestamp ? num(log.blockTimestamp) : null };
}
