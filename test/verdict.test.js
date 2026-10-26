import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict } from "../src/verdict.js";
import { claimLine } from "../src/render.js";

const DAY = 86400;
const T = 1_792_800_000; // the finalized L1 block's timestamp the reads are pinned to

const game = (over = {}) => ({
  address: "0x" + "9".repeat(40), type: 9, createdAt: T - 10 * DAY, resolvedAt: T - 6 * DAY, status: 2,
  proper: true, retired: false, blacklisted: false, claimValid: true, ...over,
});
const base = (over = {}) => ({
  chain: "op",
  l2: { txHash: "0x" + "1".repeat(64), blockNumber: 1, timestamp: T - 20 * DAY },
  withdrawal: { hash: "0x" + "2".repeat(64), target: "0x25ace71c97b33cc4729cf772ae268934f7ab5fa1", value: 10n ** 18n },
  asset: { kind: "eth", amount: 10n ** 18n, to: "0x" + "3".repeat(40) },
  feeVault: false,
  l1: { block: 100, timestamp: T },
  config: { maturitySec: 7 * DAY, finalityDelaySec: 3.5 * DAY, cadenceSec: 3600, maxClockSec: 3.5 * DAY },
  finalized: false, relay: null, proofs: [], coverage: { covered: true },
  ...over,
});

test("finalized and relayed: done", () => {
  const v = verdict(base({ finalized: true, relay: "ok" }));
  assert.equal(v.state, "FINALIZED");
  assert.equal(v.who, null);
});

test("finalized but the L1 messenger call failed: anyone can replay it", () => {
  const v = verdict(base({ finalized: true, relay: "failed" }));
  assert.equal(v.state, "RELAY_FAILED");
  assert.equal(v.who, "anyone");
  assert.match(v.action, /relayMessage/);
});

test("not yet covered by any L1 game: waiting, about one game interval", () => {
  const v = verdict(base({ l2: { timestamp: T - 600 }, coverage: { covered: false } }));
  assert.equal(v.state, "WAITING_FOR_GAME");
  assert.equal(v.eta, T + 3600);
});

test("covered and never proven: anyone can prove", () => {
  const v = verdict(base());
  assert.equal(v.state, "READY_TO_PROVE");
  assert.equal(v.who, "anyone");
  assert.match(v.action, /proveWithdrawalTransaction/);
});

test("proven, game valid, maturity passed: anyone can finalize with that proof", () => {
  const submitter = "0x" + "4".repeat(40);
  const v = verdict(base({ proofs: [{ submitter, provenAt: T - 8 * DAY, game: game() }] }));
  assert.equal(v.state, "READY_TO_FINALIZE");
  assert.equal(v.who, "anyone");
  assert.match(v.action, new RegExp(`finalizeWithdrawalTransactionExternalProof.*${submitter}`));
  assert.deepEqual(v.proof, { submitter, provenAt: T - 8 * DAY });
});

test("proven, maturity not passed: waits until proof time + maturity", () => {
  const v = verdict(base({ proofs: [{ submitter: "0x" + "4".repeat(40), provenAt: T - 2 * DAY, game: game() }] }));
  assert.equal(v.state, "WAITING_TO_FINALIZE");
  assert.equal(v.eta, T - 2 * DAY + 7 * DAY + 1);
  assert.equal(v.proof.provenAt, T - 2 * DAY);
});

test("OP game not resolved yet: ETA is game creation + clock + air gap, or later maturity", () => {
  const g = game({ createdAt: T - DAY, resolvedAt: 0, status: 0, claimValid: false });
  const v = verdict(base({ proofs: [{ submitter: "0x" + "4".repeat(40), provenAt: T - DAY + 60, game: g }] }));
  assert.equal(v.state, "WAITING_TO_FINALIZE");
  assert.equal(v.eta, Math.max(T - DAY + 60 + 7 * DAY + 1, T - DAY + 7 * DAY));
});

test("Base game: ETA comes from the game's expectedResolution", () => {
  const g = game({ type: 621, createdAt: T - DAY, resolvedAt: 0, status: 0, claimValid: false, expectedResolution: T + 4 * DAY });
  const v = verdict(base({ chain: "base", config: { maturitySec: DAY, finalityDelaySec: 0, cadenceSec: 1200 }, proofs: [{ submitter: "0x" + "4".repeat(40), provenAt: T - DAY + 60, game: g }] }));
  assert.equal(v.state, "WAITING_TO_FINALIZE");
  assert.equal(v.eta, T + 4 * DAY);
});

test("the only proof is against a retired game: must be proven again", () => {
  const v = verdict(base({ proofs: [{ submitter: "0x" + "4".repeat(40), provenAt: T - 400 * DAY, game: game({ proper: false, retired: true, claimValid: false }) }] }));
  assert.equal(v.state, "READY_TO_PROVE");
  assert.ok(v.notes.some((n) => /retired/.test(n)));
});

test("one dead proof and one live one: the live one decides", () => {
  const dead = { submitter: "0x" + "5".repeat(40), provenAt: T - 9 * DAY, game: game({ status: 1, claimValid: false }) };
  const live = { submitter: "0x" + "6".repeat(40), provenAt: T - 8 * DAY, game: game() };
  assert.equal(verdict(base({ proofs: [dead, live] })).state, "READY_TO_FINALIZE");
});

test("a proof sent in the same second the game was created does not count", () => {
  const g = game();
  assert.equal(verdict(base({ proofs: [{ submitter: "0x" + "4".repeat(40), provenAt: g.createdAt, game: g }] })).state, "READY_TO_PROVE");
});

test("fee-vault withdrawals are labelled as protocol revenue", () => {
  assert.ok(verdict(base({ feeVault: true })).notes.some((n) => /fee vault/i.test(n)));
});

// Arbitrum One: L2ToL1Tx, then a BoLD assertion that includes it is confirmed, then anyone claims it from the Outbox.
const BLOCK = 26_000_000; // the finalized L1 block the reads are pinned to
const arb = (over = {}) => ({
  chain: "arb",
  stack: "arbitrum",
  l2: { txHash: "0x" + "1".repeat(64), blockNumber: 500_000_000, timestamp: T - 3 * DAY, withdrawals: 1, index: 0 },
  withdrawal: {
    hash: "0x" + "2".repeat(64), position: 167_000, sender: "0x" + "3".repeat(40), target: "0x" + "3".repeat(40),
    value: 10n ** 18n, arbBlockNum: 500_000_000, ethBlockNum: BLOCK - 21_600, timestamp: T - 3 * DAY, data: "0x",
  },
  asset: { kind: "eth", amount: 10n ** 18n, from: "0x" + "3".repeat(40), to: "0x" + "3".repeat(40) },
  feeVault: false,
  l1: { block: BLOCK, timestamp: T },
  config: { confirmPeriodBlocks: 45_818, l1BlockSec: 12, cadenceSec: 3600, anyoneCanConfirm: true },
  spent: false, claim: null, claimLookup: null,
  confirmed: { assertion: "0x" + "a".repeat(64), l2Block: 499_000_000, sendCount: 166_900, covered: false },
  covering: { assertion: "0x" + "b".repeat(64), createdAtBlock: BLOCK - 21_000, deadlineBlock: BLOCK - 21_000 + 45_818 },
  proof: null,
  ...over,
});

test("Arbitrum: included in an assertion, window running: waiting until its deadline block", () => {
  const v = verdict(arb());
  assert.equal(v.state, "WAITING_FOR_CONFIRMATION");
  assert.equal(v.who, null);
  assert.equal(v.eta, T + (45_818 - 21_000) * 12);
  assert.match(v.summary, /6\.4-day/);
});

test("Arbitrum: no assertion includes it yet: next assertion plus the full window", () => {
  const v = verdict(arb({ covering: null }));
  assert.equal(v.state, "WAITING_FOR_CONFIRMATION");
  assert.equal(v.eta, T + 3600 + 45_818 * 12);
});

test("Arbitrum: window over but not confirmed yet: due now, and anyone may confirm on Arbitrum One", () => {
  const v = verdict(arb({ covering: { assertion: "0x" + "b".repeat(64), createdAtBlock: BLOCK - 46_000, deadlineBlock: BLOCK - 182 } }));
  assert.equal(v.state, "WAITING_FOR_CONFIRMATION");
  assert.equal(v.eta, T);
  assert.ok(v.notes.some((n) => /confirmAssertion/.test(n)));
});

test("Robinhood Chain: window over but not confirmed yet: due now, and only its whitelisted validators may confirm", () => {
  const v = verdict(arb({
    chain: "robinhood",
    config: { confirmPeriodBlocks: 45_818, l1BlockSec: 12, cadenceSec: 1800, anyoneCanConfirm: false },
    covering: { assertion: "0x" + "b".repeat(64), createdAtBlock: BLOCK - 46_000, deadlineBlock: BLOCK - 182 },
  }));
  assert.equal(v.state, "WAITING_FOR_CONFIRMATION");
  assert.equal(v.eta, T);
  assert.ok(v.notes.some((n) => /only (its|the rollup's) whitelisted validators may confirm/.test(n)));
  assert.ok(v.notes.some((n) => /about every 30 minutes/.test(n)));
  assert.ok(!v.notes.some((n) => /anyone may confirm/.test(n)));
});

test("Arbitrum: confirmed and not spent: anyone can claim it from the Outbox", () => {
  const v = verdict(arb({ confirmed: { assertion: "0x" + "a".repeat(64), l2Block: 501_000_000, sendCount: 167_100, covered: true }, covering: null }));
  assert.equal(v.state, "READY_TO_CLAIM");
  assert.equal(v.who, "anyone");
  assert.equal(v.eta, null);
  assert.match(v.action, /^Outbox\.executeTransaction\(.*167000/);
});

test("Arbitrum: spent, claimed by the recipient: done, no third-party note", () => {
  const claim = { by: "0x" + "3".repeat(40), txHash: "0x" + "c".repeat(64), block: BLOCK - 10, timestamp: T - 120 };
  const v = verdict(arb({ spent: true, claim }));
  assert.equal(v.state, "CLAIMED");
  assert.equal(v.who, null);
  assert.deepEqual(v.claim, claim);
  assert.ok(!v.notes.some((n) => /owed/.test(n)));
});

test("Arbitrum: spent, claimed by someone else: done, and nothing is owed to them", () => {
  const claim = { by: "0xa77028cd034fae57dd4acb50ebcb9c074d569e64", txHash: "0x" + "c".repeat(64), block: BLOCK - 10, timestamp: T - 120 };
  const v = verdict(arb({ spent: true, claim }));
  assert.equal(v.state, "CLAIMED");
  assert.ok(v.notes.some((n) => /nothing is owed/i.test(n)));
});

test("Arbitrum: spent, claimer not found with free RPCs: done, and it says so", () => {
  const v = verdict(arb({ spent: true, claim: null, claimLookup: "failed" }));
  assert.equal(v.state, "CLAIMED");
  assert.equal(v.claim, null);
  assert.ok(v.notes.some((n) => /who sent the claim/.test(n)));
});

test("Arbitrum: spent, claimer still being looked up: done now, and no 'could not find' yet", () => {
  const v = verdict(arb({ spent: true, claim: null, claimLookup: "pending" }));
  assert.equal(v.state, "CLAIMED");
  assert.equal(v.claim, null);
  assert.equal(v.notes.length, 0);
});

test("the claimer line: pending, found, or could not tell", () => {
  const f = arb({ spent: true });
  assert.equal(claimLine({ claim: null }, { ...f, claimLookup: "pending" }), "Finding who claimed it…");
  assert.equal(claimLine({ state: "FINALIZED", claim: null }, { stack: "zksync", finalized: true, claimLookup: "pending" }), "Finding who finalized it…");
  assert.match(claimLine({ claim: null }, { ...f, claimLookup: "failed" }), /^Could not tell/);
  assert.match(claimLine({ claim: null }, { ...f, claimLookup: "not-found" }), /^Could not tell/);
  const claim = { by: "0xa77028cd034fae57dd4acb50ebcb9c074d569e64", block: BLOCK - 10, timestamp: T - 120 };
  assert.match(claimLine({ claim }, f), /UTC by 0xa77028cd034fae57dd4acb50ebcb9c074d569e64 \(unlost\.eth/);
  assert.equal(claimLine({ claim: null }, { ...f, spent: false }), null);
});

test("Arbitrum: ready, but the L2 RPC's proof does not check out on L1: still ready, with a warning", () => {
  const proof = { size: 167_100, leaf: "0x" + "9".repeat(64), root: "0x" + "8".repeat(64), hashes: ["0x" + "7".repeat(64)], leafMatches: false, rootConfirmed: false };
  const v = verdict(arb({ confirmed: { assertion: "0x" + "a".repeat(64), l2Block: 501_000_000, sendCount: 167_100, covered: true }, covering: null, proof }));
  assert.equal(v.state, "READY_TO_CLAIM");
  assert.ok(v.notes.some((n) => /proof .* did not check out/.test(n)));
});

// Linea: MessageSent on L2, then the L1 rollup finalizes that L2 block, then anyone claims on L1. Nothing auto-claims.
const UNLOST = "0xa77028cd034fae57dd4acb50ebcb9c074d569e64";
const lin = (over = {}) => ({
  chain: "linea",
  stack: "linea",
  l2: { txHash: "0x" + "1".repeat(64), blockNumber: 32_000_000, timestamp: T - 3 * DAY, withdrawals: 1, index: 0 },
  withdrawal: {
    hash: "0x" + "2".repeat(64), nonce: 108_000n, from: "0x" + "3".repeat(40), to: "0x" + "3".repeat(40),
    fee: 0n, value: 10n ** 17n, data: "0x", legacy: false,
  },
  asset: { kind: "eth", amount: 10n ** 17n, from: "0x" + "3".repeat(40), to: "0x" + "3".repeat(40) },
  feeVault: false,
  l1: { block: BLOCK, timestamp: T },
  config: {
    finalizedL2Block: 32_100_000, finalizedL2Timestamp: T - 2 * 3600,
    rateLimit: { limitWei: 10_000n * 10n ** 18n, usedWei: 20n * 10n ** 18n, periodEnd: T + 3600 },
    paused: false,
  },
  finalized: true, claimed: false, claim: null, claimLookup: null,
  proof: { root: "0x" + "8".repeat(64), depth: 5, leafIndex: 3, hashes: Array(5).fill("0x" + "7".repeat(64)), rootConfirmed: true, anchoredAt: BLOCK - 20_000 },
  ...over,
});

test("Linea: finalized on L1 and not claimed: anyone can claim, with the proof rebuilt from the finalization", () => {
  const v = verdict(lin());
  assert.equal(v.state, "READY_TO_CLAIM");
  assert.equal(v.who, "anyone");
  assert.equal(v.eta, null);
  assert.match(v.action, /^LineaRollup\.claimMessageWithProof\(\{proof: 5 hashes, messageNumber: 108000, leafIndex: 3, from: 0x3+, to: 0x3+, fee: 0, value: 100000000000000000, feeRecipient: /);
  assert.ok(!v.notes.some((n) => /fee/.test(n)));
});

test("Linea: a message from before L2 block 2,242,568 uses the legacy claimMessage, no proof", () => {
  const v = verdict(lin({ l2: { ...lin().l2, blockNumber: 2_240_365 }, withdrawal: { ...lin().withdrawal, legacy: true }, proof: null }));
  assert.equal(v.state, "READY_TO_CLAIM");
  assert.match(v.action, /^LineaRollup\.claimMessage\(0x3+, 0x3+, 0, 100000000000000000, /);
});

test("Linea: the L2 block is not finalized on L1 yet: waiting, ETA from the current finalization lag", () => {
  const v = verdict(lin({ l2: { ...lin().l2, timestamp: T - 1800 }, finalized: false, proof: null }));
  assert.equal(v.state, "WAITING_FOR_FINALIZATION");
  assert.equal(v.who, null);
  assert.equal(v.eta, T - 1800 + 2 * 3600);
});

test("Linea: past the usual lag but still not finalized: due now", () => {
  const v = verdict(lin({ l2: { ...lin().l2, timestamp: T - 5 * 3600 }, finalized: false, proof: null }));
  assert.equal(v.eta, T);
});

test("Linea: claimed by the recipient: done, no third-party note", () => {
  const claim = { by: "0x" + "3".repeat(40), txHash: "0x" + "c".repeat(64), block: BLOCK - 10, timestamp: T - 120 };
  const v = verdict(lin({ claimed: true, claim, proof: null }));
  assert.equal(v.state, "CLAIMED");
  assert.equal(v.who, null);
  assert.deepEqual(v.claim, claim);
  assert.ok(!v.notes.some((n) => /owed/.test(n)));
});

test("Linea: claimed by unlost.eth: done, and nothing is owed", () => {
  const claim = { by: UNLOST, txHash: "0x" + "c".repeat(64), block: BLOCK - 10, timestamp: T - 120 };
  const v = verdict(lin({ claimed: true, claim, proof: null }));
  assert.equal(v.state, "CLAIMED");
  assert.ok(v.notes.some((n) => /nothing is owed/i.test(n)));
});

test("Linea: claimed, claimer not found: done, and it says so", () => {
  const v = verdict(lin({ claimed: true, claimLookup: "not-found", proof: null }));
  assert.equal(v.state, "CLAIMED");
  assert.ok(v.notes.some((n) => /who sent the claim/.test(n)));
});

test("Linea: a fee paid on L2 goes to whoever claims", () => {
  const v = verdict(lin({ withdrawal: { ...lin().withdrawal, fee: 10n ** 15n } }));
  assert.ok(v.notes.some((n) => /0\.001 ETH fee .* whoever sends the claim/.test(n)));
});

test("Linea: unclaimed after 90 days: the bridge app no longer lists it", () => {
  const v = verdict(lin({ l2: { ...lin().l2, timestamp: T - 200 * DAY } }));
  assert.ok(v.notes.some((n) => /90 days/.test(n)));
  assert.ok(!verdict(lin()).notes.some((n) => /90 days/.test(n)));
});

test("Linea: the daily L1 limit would be exceeded: the claim reverts until the period ends", () => {
  const rateLimit = { limitWei: 10_000n * 10n ** 18n, usedWei: 9_999n * 10n ** 18n, periodEnd: T + 3600 };
  const v = verdict(lin({ withdrawal: { ...lin().withdrawal, value: 5n * 10n ** 18n }, asset: { ...lin().asset, amount: 5n * 10n ** 18n }, config: { ...lin().config, rateLimit } }));
  assert.equal(v.state, "READY_TO_CLAIM");
  assert.ok(v.notes.some((n) => /daily limit/.test(n)));
  // a new period starts once periodEnd has passed, so the used amount no longer counts
  const later = verdict(lin({ withdrawal: { ...lin().withdrawal, value: 5n * 10n ** 18n }, config: { ...lin().config, rateLimit: { ...rateLimit, periodEnd: T - 1 } } }));
  assert.ok(!later.notes.some((n) => /daily limit/.test(n)));
});

test("Linea: claims paused on L1: still ready, with a warning", () => {
  const v = verdict(lin({ config: { ...lin().config, paused: true } }));
  assert.equal(v.state, "READY_TO_CLAIM");
  assert.ok(v.notes.some((n) => /paused/.test(n)));
});

test("Linea: ready, but the rebuilt proof's root is not on L1: still ready, with a warning", () => {
  const v = verdict(lin({ proof: { ...lin().proof, rootConfirmed: false } }));
  assert.ok(v.notes.some((n) => /proof .* did not check out/.test(n)));
});

// ZKsync Era: an L2-to-L1 log in batch N; once N is executed on L1 anyone can finalize on the L1Nullifier. Most are
// finalized automatically by the batch finalizer.
const FINALIZER = "0xf8a16864d8de145a266a534174305f881ee2315e";
const zk = (over = {}) => ({
  chain: "zksync",
  stack: "zksync",
  l2: { txHash: "0x" + "1".repeat(64), blockNumber: 72_000_000, timestamp: T - 3 * DAY, withdrawals: 1, index: 0 },
  withdrawal: {
    hash: "0x" + "2".repeat(64), sender: "0x000000000000000000000000000000000000800a", message: "0x6c0960f9" + "3".repeat(40) + "0".repeat(48) + "016345785d8a0000",
    batch: 518_000, txNumberInBatch: 12, logIndex: 0, index: 7,
  },
  asset: { kind: "eth", amount: 10n ** 17n, from: "0x" + "3".repeat(40), to: "0x" + "3".repeat(40) },
  feeVault: false,
  l1: { block: BLOCK, timestamp: T },
  batch: { number: 518_000, totalExecuted: 519_000, executed: true, timestamp: T - 3 * DAY, committedAt: T - 3 * DAY + 600 },
  latest: { number: 519_000, timestamp: T - 30 * 3600, committedAt: T - 29 * 3600, executedAt: T - 5 * 3600 },
  finalized: false, finalizedBy: null, claim: null, claimLookup: null,
  proof: { id: 7, root: "0x" + "8".repeat(64), hashes: Array(16).fill("0x" + "7".repeat(64)), simulated: true },
  ...over,
});

test("ZKsync: batch executed, not finalized: anyone can finalize, and it says most finish automatically", () => {
  const v = verdict(zk());
  assert.equal(v.state, "READY_TO_FINALIZE");
  assert.equal(v.who, "anyone");
  assert.match(v.action, /^L1Nullifier\.finalizeDeposit\(\{chainId: 324, l2BatchNumber: 518000, l2MessageIndex: 7, l2Sender: 0x0+800a, l2TxNumberInBatch: 12, message: 0x6c0960f9/);
  assert.match(v.action, /merkleProof: 16 hashes/);
  assert.ok(v.notes.some((n) => /automatically/.test(n)));
});

test("ZKsync: ready, but a dry run of the call on L1 failed: still ready, with a warning", () => {
  const v = verdict(zk({ proof: { ...zk().proof, simulated: false } }));
  assert.equal(v.state, "READY_TO_FINALIZE");
  assert.ok(v.notes.some((n) => /dry run/.test(n)));
});

test("ZKsync: batch committed, not executed: waiting, ETA from the latest executed batch's commit-to-execute time", () => {
  const v = verdict(zk({ batch: { number: 519_100, totalExecuted: 519_000, executed: false, timestamp: T - 3600, committedAt: T - 1800 }, proof: null }));
  assert.equal(v.state, "WAITING_FOR_BATCH");
  assert.equal(v.who, null);
  assert.equal(v.eta, T - 1800 + 24 * 3600);
  assert.match(v.summary, /automatically/);
});

test("ZKsync: not committed yet: ETA from the latest executed batch's age at execution", () => {
  const v = verdict(zk({ l2: { ...zk().l2, timestamp: T - 600 }, batch: { number: null, totalExecuted: 519_000, executed: false, timestamp: null, committedAt: null }, proof: null }));
  assert.equal(v.state, "WAITING_FOR_BATCH");
  assert.equal(v.eta, T - 600 + 25 * 3600);
});

test("ZKsync: overdue: due now", () => {
  const v = verdict(zk({ batch: { number: 519_001, totalExecuted: 519_000, executed: false, timestamp: T - 3 * DAY, committedAt: T - 3 * DAY }, proof: null }));
  assert.equal(v.eta, T);
});

test("ZKsync: finalized by the automatic finalizer: done, and it is named as such", () => {
  const claim = { by: "0x402baa76f30fdd3c98804057387a63f0f5b92e8b", via: FINALIZER, txHash: "0x" + "c".repeat(64), block: BLOCK - 10, timestamp: T - 120 };
  const v = verdict(zk({ finalized: true, finalizedBy: "nullifier", claim, proof: null }));
  assert.equal(v.state, "FINALIZED");
  assert.equal(v.who, null);
  assert.deepEqual(v.claim, claim);
  assert.ok(v.notes.some((n) => /WithdrawalFinalizer/.test(n)));
  assert.ok(!v.notes.some((n) => /owed/.test(n)));
});

test("ZKsync: finalized by unlost.eth: done, and nothing is owed", () => {
  const claim = { by: UNLOST, via: "0xd7f9f54194c633f36ccd5f3da84ad4a1c38cb2cb", txHash: "0x" + "c".repeat(64), block: BLOCK - 10, timestamp: T - 120 };
  const v = verdict(zk({ finalized: true, finalizedBy: "nullifier", claim, proof: null }));
  assert.equal(v.state, "FINALIZED");
  assert.ok(v.notes.some((n) => /nothing is owed/i.test(n)));
});

test("ZKsync: finalized before the shared bridge, on the old contracts: done; claimer lookup failure is said", () => {
  const v = verdict(zk({ finalized: true, finalizedBy: "legacy-eth", claimLookup: "failed", proof: null }));
  assert.equal(v.state, "FINALIZED");
  assert.ok(v.notes.some((n) => /who sent/.test(n)));
});
