// Scroll (the original of Morph's rollup family), replayed from RPC + bridge-API answers recorded on 10 Nov 2026
// (scripts/record.mjs scroll …). No network. Every address, the SentMessage signature, the message-hash encoding, the
// WithdrawTrieVerifier proof fold, the relayMessageWithProof selector (0xc311b6fc) and the validity-proof finality
// (ScrollChain has no finalizationPeriodSeconds) were verified on chain before these fixtures were cut (see
// src/scroll.js and src/chains.js). Scroll's public bridge-history API serves the Merkle proof, so a claimable
// withdrawal is a FULL claim, and the reader trusts the API proof only after folding it to the on-chain withdraw root.
//
// Fixtures: scroll-claimable-eth, scroll-claimed-erc20, scroll-claimed-eth and scroll-not-a-withdrawal are REAL
// mainnet withdrawals. The not-yet-finalized stage has no stable real example (Scroll finalizes within the hour and
// withdrawals are infrequent), so it is covered by a pure, clearly-labelled SYNTHETIC verdict/steps test below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "../src/check.js";
import { replaying, replayingApi } from "../src/rpc.js";
import { renderText } from "../src/render.js";
import { buildClaim, encodeScrollClaim } from "../src/claim.js";
import { foldProof } from "../src/scroll.js";
import { messageHash, withdrawalsIn } from "../src/morph.js";
import { verdict } from "../src/verdict.js";
import { stepsOf } from "../src/steps.js";
import { CHAINS } from "../src/chains.js";

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
const clientsFrom = (fx) => () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2), l1Archive: replaying(fx.store.l1), api: replayingApi(fx.store.api) });

async function replay(name) {
  const fx = load(name);
  return check(fx.tx, { chain: fx.chain, index: fx.index, clients: clientsFrom(fx) });
}

test("Scroll, 0.00398956 ETH finalized and unclaimed: READY_TO_CLAIM with a FULL relayMessageWithProof claim", async () => {
  const r = await replay("scroll-claimable-eth");
  assert.equal(r.facts.chain, "scroll");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.finalized, true);
  assert.equal(r.facts.claimed, false);
  assert.equal(r.facts.hashVerified, true); // matched its AppendMessage entry in the withdraw tree
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 3989563030494190n);
  assert.equal(r.facts.asset.to, "0x081fa64b6667f0abbce89bbb08d64ddc6096e759"); // the real recipient, not the gateway
  // The proof came from Scroll's API but is trusted only because it folds to the on-chain withdraw root.
  assert.equal(r.facts.proof.batchIndex, 520834);
  assert.equal(r.facts.proof.hashes.length, 19);
  assert.equal(r.facts.proof.rootConfirmed, true);
  assert.equal(r.facts.batch.finalized, true);
  // A real, full claim call — NOT an honest handoff like Morph.
  assert.match(r.verdict.action, /relayMessageWithProof/);
  assert.match(r.verdict.action, /batchIndex: 520834/);
  assert.doesNotMatch(r.verdict.action, /bridge app/i);
  const text = renderText(r);
  assert.match(text, /0\.00398956 ETH/);
  assert.match(text, /confirmed on L1: yes/);
});

test("Scroll, 30,000 USDC claimed on Ethereum: done, and the claimer is named", async () => {
  const r = await replay("scroll-claimed-erc20");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "USDC");
  assert.equal(r.facts.asset.decimals, 6);
  assert.equal(r.facts.asset.amount, 30000000000n);
  assert.equal(r.verdict.claim.by, "0xaa13b699226b4f9159c6d66afaad1dd18e82666a");
  assert.equal(r.verdict.claim.by, r.facts.asset.to); // claimed by its own recipient
  assert.ok(!r.verdict.notes.some((n) => /owed/.test(n)));
  assert.match(renderText(r), /30,000 USDC/);
});

test("Scroll, 0.00302698 ETH claimed on Ethereum: done", async () => {
  const r = await replay("scroll-claimed-eth");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 3026988828161519n);
  assert.equal(r.verdict.claim.by, "0x9dd13c1023fb2c6f04c4437cb722208c8c2396ac");
});

test("an ordinary Scroll transaction is not a withdrawal", async () => {
  const r = await replay("scroll-not-a-withdrawal");
  assert.equal(r.error, "not-a-withdrawal");
});

test("Scroll auto-detection finds the withdrawal when the other chains do not have the transaction", async () => {
  const fx = load("scroll-claimable-eth");
  const nowhere = { l1: async () => { throw new Error("no L1 read expected"); }, l2: async () => null };
  const mine = clientsFrom(fx)();
  const r = await check(fx.tx, { clients: (c) => (c.id === "scroll" ? mine : nowhere) });
  assert.equal(r.chain.id, "scroll");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
});

test("the message hash matches the AppendMessage leaf Scroll's withdraw tree recorded on chain (encoding is correct)", () => {
  const fx = load("scroll-claimable-eth");
  const chain = CHAINS.scroll;
  const receipt = fx.store.l2[`eth_getTransactionReceipt ["${fx.tx}"]`];
  const [w] = withdrawalsIn(receipt, chain);
  // Scroll's L2MessageQueue emits AppendMessage(uint256 index, bytes32 messageHash) with both fields in data.
  const append = receipt.logs.find(
    (l) => l.address.toLowerCase() === chain.l2MessageQueue && BigInt("0x" + l.data.slice(2, 66)) === w.nonce,
  );
  assert.ok(append, "expected an AppendMessage log for this withdrawal");
  const leaf = "0x" + append.data.slice(66, 130);
  assert.equal(messageHash(w), leaf);
  // Pinned so a future encoding change is caught.
  assert.equal(messageHash(w), "0xcac3ce4ed46de08ca140dcc3ba9314d9e3448cf0b426f1b19fc5f1b720bdbf95");
});

test("the API Merkle proof folds to the on-chain withdraw root (the proof is checked, never trusted blind)", async () => {
  const r = await replay("scroll-claimable-eth");
  const { withdrawal: w, proof: p } = r.facts;
  const folded = foldProof(w.hash, w.nonce, p.merkleProof);
  assert.equal(folded.root, p.root);
  assert.equal(folded.root, p.onchainRoot); // == ScrollChain.withdrawRoots(520834), read on chain
  assert.equal(p.onchainRoot, "0x3676cf2d1dbf9ac8a801405f3af6780a2f7ae0a40c63655b1348d9ea2ef7845f");
});

test("buildClaim on the ready Scroll withdrawal: relayMessageWithProof on the L1 messenger, rehearsal passes", async () => {
  const fx = load("scroll-claimable-eth");
  const passes = async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) });
  const c = await buildClaim(CHAINS.scroll, fx.tx, { index: fx.index, clients: clientsFrom(fx), doFetch: passes });
  assert.equal(c.call.to, CHAINS.scroll.l1Messenger);
  assert.ok(c.call.data.startsWith("0xc311b6fc"));
  assert.equal(c.rehearsal.ok, true);
});

test("encodeScrollClaim is a byte-stable relayMessageWithProof encoding (regression pin)", () => {
  const w = { from: "0x2222222222222222222222222222222222222222", to: "0x3333333333333333333333333333333333333333", value: 10n ** 15n, nonce: 98765n, message: "0x8eaac8a3" + "ab".repeat(20) };
  const proof = { batchIndex: 520834, merkleProof: "0x" + "aa".repeat(32) + "bb".repeat(32) };
  assert.equal(
    encodeScrollClaim(proof, w),
    "0xc311b6fc0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000038d7ea4c6800000000000000000000000000000000000000000000000000000000000000181cd00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000188eaac8a3abababababababababababababababababababab0000000000000000000000000000000000000000000000000000000000000000000000000007f28200000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
});

// Pure verdict/steps coverage for the stage that has no stable real fixture: a withdrawal not yet finalized on
// Ethereum. SYNTHETIC facts (clearly labelled); no network, no recorded data.
test("Scroll, not yet finalized on Ethereum (SYNTHETIC): waiting for finalization, nothing to do", () => {
  const f = {
    stack: "scroll",
    l1: { timestamp: 1_700_000_000, block: 1 },
    feeVault: false,
    hashVerified: true,
    config: { lastFinalizedBatchIndex: 520000 },
    finalized: false,
    claimed: false,
    proof: null,
    proofLookup: "not-found",
    batch: null,
    asset: { kind: "eth", amount: 10n ** 16n, to: "0x1055017502ef3559ae67f1aaa9a52b73045be011" },
    withdrawal: { hash: "0x" + "ab".repeat(32) },
  };
  const v = verdict(f);
  assert.equal(v.state, "WAITING_FOR_FINALIZATION");
  assert.equal(v.who, null);
  assert.equal(v.action, null);
  assert.match(v.summary, /validity|finalize/i);
  const steps = stepsOf("scroll", v);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].state, "done"); // Started
  assert.equal(steps[1].state, "waiting"); // Finalized on Ethereum
  assert.equal(steps[2].title, "Claim");
});
