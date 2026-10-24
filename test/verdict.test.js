import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict } from "../src/verdict.js";

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
