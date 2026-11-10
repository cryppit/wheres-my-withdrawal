// Morph (Scroll-style rollup), replayed from RPC answers recorded on 10 Nov 2026 (scripts/record.mjs morph …).
// No network. Addresses, the SentMessage signature, the message-hash encoding and the 2-day mainnet challenge period
// were verified against morph-l2/morph on GitHub and on chain before these fixtures were cut (see src/morph.js and
// src/chains.js). v1 tracks status and hands the claim off to Morph's bridge app; it never fabricates a proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "../src/check.js";
import { replaying } from "../src/rpc.js";
import { renderText } from "../src/render.js";
import { messageHash, withdrawalsIn } from "../src/morph.js";
import { verdict } from "../src/verdict.js";
import { stepsOf } from "../src/steps.js";
import { CHAINS } from "../src/chains.js";

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

async function replay(name) {
  const fx = load(name);
  // The claimer search uses l1Archive; the fixture records archive reads into the shared l1 store.
  return check(fx.tx, { chain: fx.chain, index: fx.index, clients: () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2), l1Archive: replaying(fx.store.l1) }) });
}

test("Morph, 1,000 USDT posted to Ethereum, inside the 2-day challenge period: waiting, nothing to do", async () => {
  const r = await replay("morph-challenge-usdt");
  assert.equal(r.verdict.state, "WAITING_IN_CHALLENGE");
  assert.equal(r.facts.chain, "morph");
  assert.equal(r.facts.committed, true);
  assert.equal(r.facts.finalized, false);
  assert.equal(r.facts.claimed, false);
  assert.equal(r.facts.hashVerified, true); // matched its AppendMessage entry in the withdraw tree
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "USDT");
  assert.equal(r.facts.asset.decimals, 6);
  assert.equal(r.facts.asset.amount, 1000000000n);
  assert.equal(r.facts.config.challengePeriodSec, 172800); // read live from the Rollup; 2 days on mainnet
  // The ETA is the covering batch's finalize timestamp, not invented.
  assert.equal(r.verdict.eta, r.facts.challenge.finalizeTimestamp);
  assert.equal(r.verdict.who, null);
  assert.equal(r.verdict.action, null);
  const text = renderText(r);
  assert.match(text, /1,000 USDT/);
  assert.match(text, /challenge period/);
});

test("Morph, 13.8 ETH claimed on Ethereum two days after it started: done, and the claimer is named", async () => {
  const r = await replay("morph-claimed-eth");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 13800000000000000000n);
  assert.equal(r.verdict.claim.by, "0xe2e1808ed4cc4a6f701696086838f511ee187d57");
  assert.equal(r.verdict.claim.by, r.facts.asset.to); // claimed by its own recipient
  assert.ok(!r.verdict.notes.some((n) => /owed/.test(n)));
  assert.match(renderText(r), /claimed 2026-10-30 .* \(the sender\)/);
});

test("Morph, 0.0014 ETH finalized and never claimed: ready, handed off to Morph's bridge app (no fabricated proof)", async () => {
  const r = await replay("morph-claimable-eth");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.finalized, true);
  assert.equal(r.facts.claimed, false);
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 1400000000000000n);
  // The action is an honest handoff, never a half-built claim call.
  assert.match(r.verdict.action, /bridge\.morph\.network/);
  assert.doesNotMatch(r.verdict.action, /proveAndRelayMessage/);
  assert.ok(r.verdict.notes.some((n) => /Merkle proof/.test(n) && /Morph's bridge/.test(n)));
  const text = renderText(r);
  assert.match(text, /Transactions/);
  assert.match(text, /only goes to 0x1055017502ef3559ae67f1aaa9a52b73045be011/);
});

test("an ordinary Morph transaction is not a withdrawal", async () => {
  const r = await replay("morph-not-a-withdrawal");
  assert.equal(r.error, "not-a-withdrawal");
});

test("Morph auto-detection finds the withdrawal when the other chains do not have the transaction", async () => {
  const fx = load("morph-claimable-eth");
  const nowhere = { l1: async () => { throw new Error("no L1 read expected"); }, l2: async () => null };
  const r = await check(fx.tx, { clients: (c) => (c.id === "morph" ? { l1: replaying(fx.store.l1), l2: replaying(fx.store.l2), l1Archive: replaying(fx.store.l1) } : nowhere) });
  assert.equal(r.chain.id, "morph");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
});

test("the message hash matches the AppendMessage leaf Morph's withdraw tree recorded on chain (encoding is correct)", () => {
  const fx = load("morph-challenge-usdt");
  const chain = CHAINS.morph;
  const receipt = fx.store.l2[`eth_getTransactionReceipt ["${fx.tx}"]`];
  const [w] = withdrawalsIn(receipt, chain);
  // The L2ToL1MessagePasser's AppendMessage log for leaf index == nonce carries the leaf hash. Our independently
  // computed message hash must equal it; this is what proves the relayMessage encoding is byte-correct.
  const append = receipt.logs.find(
    (l) => l.address.toLowerCase() === chain.l2MessagePasser && l.topics.length === 4 && BigInt(l.topics[1]) === w.nonce,
  );
  assert.ok(append, "expected an AppendMessage log for this withdrawal");
  assert.equal(messageHash(w), append.topics[2].toLowerCase());
  // And the hash is a real 32-byte value, pinned so a future encoding change is caught.
  assert.equal(messageHash(w), "0xdc5b7781b05037903d0e69f60698e70d4270af1bdf5b45fe79c4452c5db1b66c");
});

// Pure verdict/steps coverage for the stage that has no stable real fixture: a withdrawal not yet posted to Ethereum.
test("Morph, not yet posted to Ethereum: waiting for the batch, then the challenge period", () => {
  const f = {
    stack: "morph",
    l1: { timestamp: 1_700_000_000, block: 1 },
    feeVault: false,
    hashVerified: true,
    config: { challengePeriodSec: 172800 },
    finalized: false,
    committed: false,
    claimed: false,
    challenge: null,
    asset: { kind: "eth", amount: 10n ** 16n, to: "0x1055017502ef3559ae67f1aaa9a52b73045be011" },
    withdrawal: { hash: "0x" + "ab".repeat(32) },
  };
  const v = verdict(f);
  assert.equal(v.state, "WAITING_FOR_BATCH");
  assert.equal(v.who, null);
  assert.equal(v.action, null);
  assert.match(v.summary, /2-day challenge period/);
  const steps = stepsOf("morph", v);
  assert.equal(steps.length, 4);
  assert.equal(steps[0].state, "done"); // Started
  assert.equal(steps[1].state, "waiting"); // Posted to Ethereum
  assert.equal(steps[3].title, "Claim in Morph's bridge");
});
