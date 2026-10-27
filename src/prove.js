// The prove step of an OP Stack withdrawal, built from public data: the withdrawal, a dispute game to prove it against,
// the output root proof of that game's L2 block, the storage proof of the withdrawal in L2ToL1MessagePasser, the
// encoded proveWithdrawalTransaction call, and a rehearsal of that call with eth_call. Read-only: nothing is signed or
// sent; whoever submits the call pays only the gas, and the funds still go only to the withdrawal's recipient.

import { encodeCall, addressAt, uintAt, fromHex, selector } from "./abi.js";
import { keccak256 } from "./keccak.js";
import { SUPER_GAME_TYPES, PREDEPLOYS } from "./chains.js";
import { withdrawalsIn, legacyWithdrawalsIn } from "./opstack.js";

const strip = (h) => h.replace(/^0x/, "");
const pad = (h) => strip(h).toLowerCase().padStart(64, "0");
const uint = (v) => BigInt(v).toString(16).padStart(64, "0");
const bytesTail = (hex) => {
  const h = strip(hex).toLowerCase();
  return uint(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, "0");
};

const TX_TUPLE = "(uint256,address,address,uint256,uint256,bytes)";
const PROVE_SIG = `proveWithdrawalTransaction(${TX_TUPLE},uint256,(bytes32,bytes32,bytes32,bytes32),bytes[])`;
const FINALIZE_SIG = `finalizeWithdrawalTransaction(${TX_TUPLE})`;

/** The withdrawal tuple (nonce, sender, target, value, gasLimit, data), ABI-encoded as a dynamic tuple. */
function txTuple(tx) {
  return uint(tx.nonce) + pad(tx.sender) + pad(tx.target) + uint(tx.value) + uint(tx.gasLimit) + uint(6 * 32) + bytesTail(tx.data);
}

/** An array of `bytes`, ABI-encoded: the length, an offset per element, then each element. */
function bytesArray(items) {
  const tails = items.map(bytesTail);
  let offset = items.length * 32;
  const heads = tails.map((t) => {
    const o = uint(offset);
    offset += t.length / 2;
    return o;
  });
  return uint(items.length) + heads.join("") + tails.join("");
}

export function encodeProveCall(tx, gameIndex, orp, withdrawalProof) {
  const head = 7 * 32; // tx offset, game index, the four output root words, proof offset
  const t = txTuple(tx);
  return (
    selector(PROVE_SIG) +
    uint(head) +
    uint(gameIndex) +
    pad(orp.version) +
    pad(orp.stateRoot) +
    pad(orp.messagePasserStorageRoot) +
    pad(orp.latestBlockhash) +
    uint(head + t.length / 2) +
    t +
    bytesArray(withdrawalProof)
  );
}

export function encodeFinalizeCall(tx) {
  return selector(FINALIZE_SIG) + uint(32) + txTuple(tx);
}

/** Anyone can finalize with another account's proof: finalizeWithdrawalTransactionExternalProof(tx, proofSubmitter). */
export function encodeFinalizeExternalCall(tx, proofSubmitter) {
  return selector(`finalizeWithdrawalTransactionExternalProof(${TX_TUPLE},address)`) + uint(64) + pad(proofSubmitter) + txTuple(tx);
}

/**
 * Whether a proven withdrawal can be finalized now with `proofSubmitter`'s proof, asked of the portal itself
 * (checkWithdrawal reverts with the reason while it cannot). Read-only.
 */
export async function finalizeReadiness(portal, withdrawalHash, proofSubmitter, l1Urls, doFetch) {
  const r = await rehearse(l1Urls, { to: portal, data: encodeCall("checkWithdrawal(bytes32,address)", [withdrawalHash, proofSubmitter]) }, doFetch);
  return r.ok ? { ready: true } : { ready: false, reason: r.error };
}

/** Hashing.hashOutputRootProof: keccak256(abi.encode(version, stateRoot, messagePasserStorageRoot, latestBlockhash)). */
export const outputRootHash = (orp) => keccak256(fromHex("0x" + pad(orp.version) + pad(orp.stateRoot) + pad(orp.messagePasserStorageRoot) + pad(orp.latestBlockhash)));

/** The withdrawals mapping sits at slot 0 of L2ToL1MessagePasser, so a hash's slot is keccak256(abi.encode(hash, 0)). */
export const withdrawalSlot = (hash) => keccak256(fromHex("0x" + pad(hash) + uint(0)));

/** The L2 block at `timestamp`, counted back from the head at a fixed block time (checked against the block after). */
export const blockAtTimestamp = (head, timestamp, blockTimeSec) => head.number - (head.timestamp - timestamp) / blockTimeSec;

const ERRORS = [
  "OptimismPortal_AlreadyFinalized", "OptimismPortal_BadTarget", "OptimismPortal_CallPaused", "OptimismPortal_GasEstimation",
  "OptimismPortal_ImproperDisputeGame", "OptimismPortal_InvalidDisputeGame", "OptimismPortal_InvalidMerkleProof",
  "OptimismPortal_InvalidOutputRootProof", "OptimismPortal_InvalidProofTimestamp", "OptimismPortal_InvalidRootClaim",
  "OptimismPortal_NoReentrancy", "OptimismPortal_NotAllowedOnCGTMode", "OptimismPortal_ProofNotOldEnough", "OptimismPortal_Unproven",
];
const BY_SELECTOR = new Map(ERRORS.map((e) => [selector(`${e}()`), e]));
export const revertName = (data) => (typeof data === "string" ? BY_SELECTOR.get(data.slice(0, 10).toLowerCase()) ?? null : null);

/** One raw eth_call over the L1 endpoints that keeps the revert data (the shared client only says "reverted"). */
async function rehearse(urls, call, doFetch = globalThis.fetch) {
  const problems = [];
  for (const url of urls) {
    try {
      const body = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [call, "latest"] }), signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
      if (body.error) {
        const data = typeof body.error.data === "string" ? body.error.data : body.error.data?.data;
        return { ok: false, error: revertName(data) ?? body.error.message, data: data ?? null };
      }
      return { ok: true };
    } catch (e) {
      problems.push(`${new URL(url).host}: ${e.message}`);
    }
  }
  return { ok: false, error: `no endpoint answered (${problems.join("; ")})` };
}

/** How far back the L2 endpoints serve eth_getProof (mainnet.optimism.io: 10,000 blocks), with a margin. */
const PROOF_WINDOW = 9_000;
const GAME_STATUS = ["in progress", "challenger wins", "defender wins"];

/**
 * Everything the prove step needs, rehearsed. `from` is the account that will send it (any account works; the
 * rehearsal uses it as the sender). Throws only on transport failures; a problem with the withdrawal is returned.
 */
export async function buildProve(chain, txHash, { l1, l2 }, { index = 0, from = "0x000000000000000000000000000000000000dEaD", blockTimeSec = 2, scan = 40, l1Urls = chain.l1Rpcs, doFetch } = {}) {
  const receipt = await l2("eth_getTransactionReceipt", [txHash]);
  if (!receipt) return { error: "not-found" };
  let all = withdrawalsIn(receipt);
  if (!all.length) all = legacyWithdrawalsIn(receipt, chain);
  const w = all[index];
  if (!w) return { error: "not-a-withdrawal" };
  const tx = { nonce: w.nonce, sender: w.sender, target: w.target, value: w.value, gasLimit: w.gasLimit, data: w.data };
  const l2Block = Number(BigInt(receipt.blockNumber));

  const view = async (to, sig, args = []) => {
    const r = await l1("eth_call", [{ to, data: encodeCall(sig, args) }, "latest"]);
    return r && r.reverted ? null : r;
  };
  const portal = chain.portal;
  const dgf = addressAt(await view(portal, "disputeGameFactory()"), 0);
  const asr = addressAt(await view(portal, "anchorStateRegistry()"), 0);
  const respected = Number(uintAt(await view(asr, "respectedGameType()"), 0));
  const count = Number(uintAt(await view(dgf, "gameCount()"), 0));
  const l2ChainId = BigInt(await l2("eth_chainId", []));
  const head = await l2("eth_getBlockByNumber", ["latest", false]);
  const headN = { number: Number(BigInt(head.number)), timestamp: Number(BigInt(head.timestamp)) };
  const l1Head = await l1("eth_getBlockByNumber", ["latest", false]);
  const l1Now = Number(BigInt(l1Head.timestamp));
  const isSuper = SUPER_GAME_TYPES.has(respected);

  // The newest game of the respected type that is proper, not lost, created before now, and whose L2 block the
  // endpoints can still prove (proofs stay valid after that window; only building them needs it).
  let game = null;
  const skipped = [];
  for (let i = count - 1; i >= Math.max(0, count - scan) && !game; i--) {
    const g = await view(dgf, "gameAtIndex(uint256)", [BigInt(i)]);
    const type = Number(uintAt(g, 0));
    const createdAt = Number(uintAt(g, 1));
    const proxy = addressAt(g, 2);
    if (type !== respected) continue;
    const status = Number(uintAt(await view(proxy, "status()"), 0));
    if (status === 1 || createdAt >= l1Now) {
      skipped.push({ index: i, why: status === 1 ? "challenger won" : "created this block" });
      continue;
    }
    const proper = await view(asr, "isGameProper(address)", [proxy]);
    const resp = await view(asr, "isGameRespected(address)", [proxy]);
    if (!proper || !uintAt(proper, 0) || !resp || !uintAt(resp, 0)) {
      skipped.push({ index: i, why: "not proper or not respected" });
      continue;
    }
    const seq = Number(uintAt(await view(proxy, "l2SequenceNumber()"), 0));
    let n = isSuper ? blockAtTimestamp(headN, seq, blockTimeSec) : seq;
    if (headN.number - n > PROOF_WINDOW) {
      skipped.push({ index: i, why: "L2 block older than the endpoints' proof window" });
      break; // older games are only further back
    }
    if (n < l2Block) break; // no newer game covers the withdrawal yet
    game = { index: i, proxy, type, createdAt, status: GAME_STATUS[status], sequence: seq, l2BlockNumber: n };
  }
  if (!game) return { error: "no-game", message: "No dispute game covers this withdrawal within the L2 endpoints' proof window.", skipped };

  // The L2 block the game claims, checked by its timestamp for super games.
  let block = await l2("eth_getBlockByNumber", ["0x" + game.l2BlockNumber.toString(16), false]);
  if (isSuper && Number(BigInt(block.timestamp)) !== game.sequence) {
    game.l2BlockNumber += (game.sequence - Number(BigInt(block.timestamp))) / blockTimeSec;
    block = await l2("eth_getBlockByNumber", ["0x" + game.l2BlockNumber.toString(16), false]);
  }
  const blockTag = "0x" + game.l2BlockNumber.toString(16);
  const slot = withdrawalSlot(w.hash);
  const proof = await l2("eth_getProof", [PREDEPLOYS.messagePasser, [slot], blockTag]);
  const orp = { version: "0x" + "00".repeat(32), stateRoot: block.stateRoot, messagePasserStorageRoot: proof.storageHash, latestBlockhash: block.hash };
  const claim = isSuper ? await view(game.proxy, "rootClaimByChainId(uint256)", [l2ChainId]) : await view(game.proxy, "rootClaim()");
  const outputRoot = outputRootHash(orp);
  const stored = proof.storageProof[0];
  const checks = {
    outputRootMatchesGame: outputRoot === "0x" + strip(claim).slice(0, 64),
    withdrawalStoredOnL2: stored && BigInt(stored.value) === 1n,
  };
  const calldata = encodeProveCall(tx, BigInt(game.index), orp, stored.proof);
  const rehearsal = await rehearse(l1Urls, { from, to: portal, data: calldata }, doFetch);
  let gas = null;
  if (rehearsal.ok) {
    const est = await l1("eth_estimateGas", [{ from, to: portal, data: calldata }]).catch(() => null);
    gas = est ? Number(BigInt(est)) : null;
  }
  return {
    withdrawal: { ...tx, hash: w.hash, l2Block },
    portal,
    game,
    outputRootProof: orp,
    outputRoot,
    withdrawalProof: stored.proof,
    checks,
    call: { to: portal, value: "0", data: calldata },
    rehearsal: { from, ...rehearsal, gas },
    finalizeCall: { to: portal, value: "0", data: encodeFinalizeCall(tx) },
  };
}
