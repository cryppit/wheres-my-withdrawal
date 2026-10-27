import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeBlastFinalizeCall } from "../src/prove.js";
import { verdict } from "../src/verdict.js";

const TX = {
  nonce: 116402n,
  sender: "0x4200000000000000000000000000000000000007",
  target: "0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1",
  value: 17980000000000000n,
  gasLimit: 1307593n,
  data: "0xd764ad0b" + "ab".repeat(37),
};

// Made with eth_abi 5.2.0, not with this code.
test("Blast's finalizeWithdrawalTransaction(hintId, tx) is encoded exactly as eth_abi encodes it", () => {
  assert.equal(
    encodeBlastFinalizeCall(708n, TX),
    "0x3dca9c4100000000000000000000000000000000000000000000000000000000000002c40000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000001c6b2000000000000000000000000420000000000000000000000000000000000000700000000000000000000000025ace71c97b33cc4729cf772ae268934f7ab5fa1000000000000000000000000000000000000000000000000003fe0b6f90fc000000000000000000000000000000000000000000000000000000000000013f3c900000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000029d764ad0bababababababababababababababababababababababababababababababababababababab0000000000000000000000000000000000000000000000",
  );
});

const NOW = 1_793_100_000;
const DAY = 86_400;
const base = (over = {}) => ({
  stack: "blast",
  withdrawal: { hash: "0x" + "11".repeat(32), value: 10n ** 17n },
  asset: { kind: "eth", amount: 10n ** 17n, to: "0x" + "22".repeat(20) },
  l1: { timestamp: NOW },
  config: { maturitySec: DAY, cadenceSec: 3600 },
  finalized: false,
  relay: null,
  proven: null,
  queue: null,
  coverage: { covered: true },
  ...over,
});
const proof = (over = {}) => ({ provenAt: NOW - 2 * DAY, outputIndex: 23000, outputRoot: "0xaa", currentRoot: "0xaa", outputTimestamp: NOW - 2 * DAY - 600, requestId: 47666n, ...over });

test("Blast: finalized", () => {
  assert.equal(verdict(base({ finalized: true, relay: "ok" })).state, "FINALIZED");
});

test("Blast: never proven, and an output covers it: anyone can prove it", () => {
  const v = verdict(base());
  assert.equal(v.state, "READY_TO_PROVE");
  assert.equal(v.who, "anyone");
});

test("Blast: no output covers it yet: waits for the next one", () => {
  const v = verdict(base({ coverage: { covered: false } }));
  assert.equal(v.state, "WAITING_FOR_GAME");
  assert.equal(v.eta, NOW + 3600);
});

test("Blast: proven a day ago, its ETH request finalized by the yield manager: ready to finalize with the checkpoint hint", () => {
  const v = verdict(base({ proven: proof(), queue: { lastFinalizedRequestId: 48718n, hint: 707n } }));
  assert.equal(v.state, "READY_TO_FINALIZE");
  assert.equal(v.who, "anyone");
  assert.match(v.action, /finalizeWithdrawalTransaction\(hintId 707,/);
});

test("Blast: proven an hour ago: waits for the one-day period after both the proof and its output", () => {
  const v = verdict(base({ proven: proof({ provenAt: NOW - 3600, outputTimestamp: NOW - 4000 }), queue: { lastFinalizedRequestId: 48718n, hint: 707n } }));
  assert.equal(v.state, "WAITING_TO_FINALIZE");
  assert.equal(v.eta, NOW - 3600 + DAY + 1);
});

test("Blast: proven, but the yield manager has not finalized its ETH request yet", () => {
  const v = verdict(base({ proven: proof({ requestId: 48800n }), queue: { lastFinalizedRequestId: 48718n, hint: 0n } }));
  assert.equal(v.state, "WAITING_TO_FINALIZE");
  assert.equal(v.eta, null);
  assert.match(v.notes.join(" "), /yield manager/);
});

test("Blast: a token withdrawal (no ETH) needs no hint", () => {
  const v = verdict(base({ withdrawal: { hash: "0x" + "11".repeat(32), value: 0n }, asset: { kind: "erc20", amount: 5n }, proven: proof({ requestId: 0n }) }));
  assert.equal(v.state, "READY_TO_FINALIZE");
  assert.match(v.action, /hintId 0,/);
});

test("Blast: the output it was proven against was replaced: it must be proven again", () => {
  const v = verdict(base({ proven: proof({ currentRoot: "0xbb" }) }));
  assert.equal(v.state, "READY_TO_PROVE");
  assert.match(v.summary, /proven again/);
});

test("Blast: a USDB withdrawal, once finalized, still waits for the recipient to claim the DAI from Blast's USD yield manager", async () => {
  const f = base({ finalized: true, relay: "ok", usdb: true, withdrawal: { hash: "0x" + "11".repeat(32), value: 0n }, asset: { kind: "erc20", amount: 5n, symbol: "DAI", to: "0x" + "22".repeat(20) } });
  const v = verdict(f);
  assert.equal(v.state, "FINALIZED");
  assert.match(v.notes.join(" "), /only the recipient can claim/i);
  const { plainNext } = await import("../src/plain.js");
  const p = plainNext({ chain: { name: "Blast", stack: "blast" }, facts: f, verdict: v });
  assert.match(p.headline, /claim/i);
  assert.doesNotMatch(p.headline, /arrived/);
});

test("Plain words follow the chain: Blast finalizes a day after the proof, Ink reports about every 11 hours", async () => {
  const { plainNext } = await import("../src/plain.js");
  const f = base();
  const p = plainNext({ chain: { name: "Blast", stack: "blast", cadenceSec: 3600 }, facts: f, verdict: verdict(f) });
  assert.match(p.steps.join(" "), /1 day later: finalize/);
  const g = base({ coverage: { covered: false } });
  const q = plainNext({ chain: { name: "Ink", stack: "op", cadenceSec: 39600 }, facts: { ...g, stack: undefined }, verdict: { state: "WAITING_FOR_GAME", eta: null } });
  assert.match(q.steps[0], /about every 11 hours/);
  assert.match(q.steps.join(" "), /7 days later finalized/);
});
