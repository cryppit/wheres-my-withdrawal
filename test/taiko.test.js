// Taiko Alethia (a based validity rollup on a SignalService + Bridge, its own family — NOT OP Stack, NOT Scroll, NOT
// the LxLy bridge), replayed from RPC answers recorded on 10 Nov 2026 (scripts/record.mjs taiko …). No network. Every
// address, the Message struct and msgHash encoding (keccak256(abi.encode("TAIKO_MESSAGE", message))), the MessageSent /
// MessageStatusChanged / CheckpointSaved events, the getSignalSlot derivation, the processMessage selector (0x2035065e),
// the HopProof layout, getCheckpoint(uint48) and the Status enum were verified on chain before these fixtures were cut
// (see src/taiko.js and src/chains.js). The signal proof is a plain eth_getProof the reader re-folds — storage leg to
// the slot's value (the msgHash) and account leg to the checkpoint's SYNCED state root — so a claimable withdrawal is a
// FULL processMessage claim, and the claim built below is byte-for-byte the one a real relayer sent on chain.
//
// Fixtures: taiko-claimable-eth, taiko-claimed-eth, taiko-claimed-erc20, taiko-retriable-eth and taiko-not-a-withdrawal
// are ALL REAL mainnet withdrawals/transactions (taiko-claimable-eth is a genuinely unclaimed 0.00236 ETH withdrawal;
// its full processMessage claim also passed a live eth_call rehearsal on L1, ~741k gas, on 10 Nov 2026). The only
// synthetic data below is the clearly-labelled "waiting for the state root to sync" verdict test (Taiko syncs a
// covering checkpoint within the hour, so that stage has no stable real fixture).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "../src/check.js";
import { replaying } from "../src/rpc.js";
import { renderText } from "../src/render.js";
import { buildClaim, encodeTaikoClaim } from "../src/claim.js";
import { withdrawalsIn, messageHash, signalSlot, encodeMessageTuple } from "../src/taiko.js";
import { verifyMerkleProof, rlpList, rlpBytes } from "../src/trie.js";
import { verdict } from "../src/verdict.js";
import { stepsOf } from "../src/steps.js";
import { CHAINS } from "../src/chains.js";

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
const clientsFrom = (fx) => () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2), l1Archive: replaying(fx.store.l1) });

async function replay(name) {
  const fx = load(name);
  return check(fx.tx, { chain: fx.chain, index: fx.index, clients: clientsFrom(fx) });
}

const strip = (h) => h.replace(/^0x/, "").toLowerCase();
const pad = (h) => "0x" + strip(h).padStart(64, "0");

test("Taiko, 0.00235598 ETH finalized and unclaimed: READY_TO_CLAIM with a FULL processMessage claim", async () => {
  const r = await replay("taiko-claimable-eth");
  assert.equal(r.facts.chain, "taiko");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.finalized, true);
  assert.equal(r.facts.claimed, false);
  assert.equal(r.facts.status, 0); // NEW
  assert.equal(r.facts.hashVerified, true); // recomputed msgHash matched the event's own topic
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 2355985546779606n);
  assert.equal(r.facts.asset.to, "0xbdc4710a64c7bbb04b770433e5b21105058543aa");
  assert.equal(r.facts.withdrawal.hash, "0xee386bdb1c666b20c82b4c8be193714d8a915c59a3d42bb650bbc5c9d21e3f78");
  // The proof came from eth_getProof but is trusted only because it folds to the SYNCED checkpoint state root.
  assert.equal(r.facts.proof.rootConfirmed, true);
  assert.equal(r.facts.proof.signalPresent, true);
  assert.equal(r.facts.checkpoint.coversWithdrawal, true);
  assert.ok(r.facts.checkpoint.blockNumber >= r.facts.l2.blockNumber);
  // A real, full claim call — NOT an honest handoff like Morph.
  assert.match(r.verdict.action, /processMessage/);
  assert.doesNotMatch(r.verdict.action, /bridge app/i);
  const text = renderText(r);
  assert.match(text, /0\.00235598 ETH/);
  assert.match(text, /proof checks out: yes/);
});

test("Taiko, 0.00711865 ETH claimed on Ethereum: done, and the claimer is named", async () => {
  const r = await replay("taiko-claimed-eth");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.claimed, true);
  assert.equal(r.facts.status, 2); // DONE
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 7118657492000000n);
  assert.equal(r.facts.withdrawal.hash, "0x926d5e351466d91e823399723be753d0bfe07d55d87d2ea9db3e85150383932f");
  assert.equal(r.verdict.claim.by, "0x0000001539d3a970c979ac67a8836a359ce4a1fc"); // the relayer that finished it
  assert.match(renderText(r), /0\.00711865 ETH/);
});

test("Taiko, 674.76898935 TKO claimed on Ethereum: done, token decoded from the message itself", async () => {
  const r = await replay("taiko-claimed-erc20");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "TKO");
  assert.equal(r.facts.asset.decimals, 18);
  assert.equal(r.facts.asset.amount, 674768989357743000000n);
  assert.equal(r.facts.asset.to, "0x6129aeaf582dd8b748772e19fb7a80af26d4c2d3");
  assert.match(renderText(r), /674\.76898935 TKO/);
});

test("Taiko, a RETRIABLE message: delivered but the final step failed, anyone can retry", async () => {
  const r = await replay("taiko-retriable-eth");
  assert.equal(r.facts.status, 1); // RETRIABLE
  assert.equal(r.facts.claimed, false);
  assert.equal(r.facts.finalized, false);
  assert.equal(r.facts.proof, null); // a non-NEW message is never proved
  assert.equal(r.verdict.state, "RELAY_FAILED");
  assert.equal(r.verdict.who, "anyone");
  assert.match(r.verdict.action, /retryMessage/);
});

test("an ordinary Taiko transaction is not a withdrawal", async () => {
  const r = await replay("taiko-not-a-withdrawal");
  assert.equal(r.error, "not-a-withdrawal");
});

test("Taiko auto-detection finds the withdrawal when the other chains do not have the transaction", async () => {
  const fx = load("taiko-claimable-eth");
  const nowhere = { l1: async () => { throw new Error("no L1 read expected"); }, l2: async () => null };
  const mine = clientsFrom(fx)();
  const r = await check(fx.tx, { clients: (c) => (c.id === "taiko" ? mine : nowhere) });
  assert.equal(r.chain.id, "taiko");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
});

test("the message hash is keccak256(abi.encode(\"TAIKO_MESSAGE\", message)) and matches the event (encoding is correct)", () => {
  const fx = load("taiko-claimed-eth");
  const chain = CHAINS.taiko;
  const receipt = fx.store.l2[`eth_getTransactionReceipt ["${fx.tx}"]`];
  const [w] = withdrawalsIn(receipt, chain);
  assert.equal(messageHash(w.message), w.eventHash); // recomputed == the event's indexed msgHash topic
  // Pinned so a future encoding change is caught.
  assert.equal(messageHash(w.message), "0x926d5e351466d91e823399723be753d0bfe07d55d87d2ea9db3e85150383932f");
  // The signal slot keys on srcChainId (167000), the L2 Bridge and the msgHash.
  assert.equal(w.slot, signalSlot(167000n, chain.l2Bridge, w.hash));
  assert.equal(w.slot, "0xeeb68ca1be6497dfa9da9e19ad9e27360484d5f3d08963072cd17e9209e9d99a");
});

test("the signal proof folds to the state root TaikoInbox synced to L1 (the proof is checked, never trusted blind)", async () => {
  const r = await replay("taiko-claimable-eth");
  const { proof: p } = r.facts;
  const chain = CHAINS.taiko;
  // Storage leg: fold to the account's storage root; the leaf value is RLP(msgHash).
  const storage = verifyMerkleProof(p.storageHash, r.facts.withdrawal.slot, p.storageProof);
  assert.equal(storage.ok, true);
  assert.equal(pad(rlpBytes(storage.value)), r.facts.withdrawal.hash);
  // Account leg: fold to the checkpoint's SYNCED state root; the account's storage root equals the one above.
  const account = verifyMerkleProof(p.rootHash, chain.l2SignalService, p.accountProof);
  assert.equal(account.ok, true);
  const items = rlpList(account.value);
  assert.equal(pad(items[2]), pad(p.storageHash)); // account.storageRoot == the storage proof's root
  // And that synced root is the checkpoint TaikoInbox wrote on L1.
  assert.equal(r.facts.checkpoint.stateRoot, p.rootHash);
});

test("buildClaim on the ready Taiko withdrawal: processMessage on the L1 Bridge, selector 0x2035065e, rehearsal passes", async () => {
  const fx = load("taiko-claimable-eth");
  const passes = async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) });
  const c = await buildClaim(CHAINS.taiko, fx.tx, { index: fx.index, clients: clientsFrom(fx), doFetch: passes });
  assert.equal(c.call.to, CHAINS.taiko.l1Bridge);
  assert.ok(c.call.data.startsWith("0x2035065e"));
  assert.equal(c.rehearsal.ok, true);
});

test("encodeTaikoClaim is a byte-stable processMessage encoding (regression pin)", () => {
  const m = { id: 42n, fee: 1000n, gasLimit: 500000n, from: "0x1111111111111111111111111111111111111111", srcChainId: 167000n, srcOwner: "0x2222222222222222222222222222222222222222", destChainId: 1n, destOwner: "0x3333333333333333333333333333333333333333", to: "0x3333333333333333333333333333333333333333", value: 10n ** 15n, data: "0x" };
  const hop = { chainId: 1, blockId: 13841645, rootHash: "0x" + "ab".repeat(32), cacheOption: 0, accountProof: ["0xf84455", "0xaabbcc"], storageProof: ["0xa0" + "11".repeat(32)] };
  assert.equal(messageHash(m), "0xd71d9ff75bca6c6bd8320fe48bc78062108f36dc3bf999814aed6b1f59c740dd");
  assert.equal(signalSlot(167000n, "0x1670000000000000000000000000000000000001", messageHash(m)), "0xe9246b9d11012bdbd6d020bf245f37a47b6896f9ac1f4f6e6904ec54304c31c2");
  assert.equal(
    encodeTaikoClaim(m, hop),
    "0x2035065e000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000002a00000000000000000000000000000000000000000000000000000000000003e8000000000000000000000000000000000000000000000000000000000007a12000000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000028c58000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000000000010000000000000000000000003333333333333333333333333333333333333333000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000160000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000d334edabababababababababababababababababababababababababababababababab000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000003f8445500000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000003aabbcc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000021a0111111111111111111111111111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000",
  );
});

// Pure verdict/steps coverage for the stage that has no stable real fixture: a withdrawal whose L2 block has not been
// synced to Ethereum yet. SYNTHETIC facts (clearly labelled); no network, no recorded data.
test("Taiko, state root not synced to Ethereum yet (SYNTHETIC): waiting for finalization, nothing to do", () => {
  const f = {
    stack: "taiko",
    l1: { timestamp: 1_700_000_000, block: 1 },
    l2: { blockNumber: 14_000_000 },
    feeVault: false,
    hashVerified: true,
    status: 0,
    finalized: false,
    claimed: false,
    checkpoint: { blockNumber: 13_900_000, stateRoot: "0x" + "cd".repeat(32), coversWithdrawal: false },
    proof: null,
    proofLookup: null,
    asset: { kind: "eth", amount: 10n ** 16n, to: "0x1055017502ef3559ae67f1aaa9a52b73045be011" },
    withdrawal: { hash: "0x" + "ab".repeat(32) },
  };
  const v = verdict(f);
  assert.equal(v.state, "WAITING_FOR_FINALIZATION");
  assert.equal(v.who, null);
  assert.equal(v.action, null);
  assert.ok(v.notes.some((n) => /synced/.test(n)));
  const steps = stepsOf("taiko", v);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].state, "done"); // Started
  assert.equal(steps[1].state, "waiting"); // Synced to Ethereum
  assert.equal(steps[2].title, "Claim");
});
