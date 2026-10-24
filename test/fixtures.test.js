// Real withdrawals, replayed from the RPC answers recorded on 24 Oct 2026 (scripts/record.mjs). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "../src/check.js";
import { replaying } from "../src/rpc.js";
import { renderText } from "../src/render.js";

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));

async function replay(name) {
  const fx = load(name);
  return check(fx.tx, { chain: fx.chain, index: fx.index, clients: () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2) }) });
}

test("OP, May 2024, re-proven by unlost.eth on 24 Oct: waiting, finalize from 31 Oct", async () => {
  const r = await replay("op-proven-by-unlost");
  assert.equal(r.verdict.state, "WAITING_TO_FINALIZE");
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 569100000000000000n);
  assert.equal(r.verdict.proof.submitter, "0xa77028cd034fae57dd4acb50ebcb9c074d569e64");
  assert.equal(r.facts.proofs[0].game.type, 9);
  assert.match(renderText(r), /unlost\.eth/);
  assert.match(renderText(r), /2026-10-31/);
});

test("OP, Dec 2023, proven again on 20 Oct by a third party", async () => {
  const r = await replay("op-2023-reprove");
  assert.equal(r.verdict.state, "WAITING_TO_FINALIZE");
  assert.match(renderText(r), /a third party/);
});

test("OP, Aug 2023, never proven under fault proofs: anyone can prove it", async () => {
  const r = await replay("op-2023-ready-to-prove");
  assert.equal(r.verdict.state, "READY_TO_PROVE");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.proofs.length, 0);
  assert.equal(r.facts.coverage.covered, true);
  assert.equal(r.facts.asset.amount, 76135760301306792n);
});

test("OP, finalized and relayed", async () => {
  const r = await replay("op-finalized");
  assert.equal(r.verdict.state, "FINALIZED");
  assert.equal(r.facts.relay, "ok");
});

test("Base, started today, proven within the hour: the 5-day game window decides", async () => {
  const r = await replay("base-proven");
  assert.equal(r.verdict.state, "WAITING_TO_FINALIZE");
  assert.equal(r.facts.config.maturitySec, 86400);
  assert.equal(r.facts.config.finalityDelaySec, 0);
  const g = r.facts.proofs[0].game;
  assert.equal(g.type, 621);
  assert.equal(r.verdict.eta, g.expectedResolution);
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "HAIR");
});

test("Base, finalized ERC-20 withdrawal", async () => {
  const r = await replay("base-finalized");
  assert.equal(r.verdict.state, "FINALIZED");
  assert.equal(r.facts.asset.symbol, "NFD");
});

test("an ordinary OP transaction is not a withdrawal", async () => {
  const r = await replay("op-not-a-withdrawal");
  assert.equal(r.error, "not-a-withdrawal");
});

// Arbitrum One, recorded on 24 Oct 2026 at finalized L1 block 26261887 (the two claimed ones again at 26262206, when
// the claimer search changed). The latest confirmed assertion then covered sends up to position 167051.

test("Arbitrum, Feb 2023, 0.1 ETH claimed by unlost.eth on 23 Oct: done, and the claimer is named", async () => {
  const r = await replay("arb-claimed-by-unlost");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.withdrawal.position, 44574);
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 100000000000000000n);
  assert.equal(r.verdict.claim.by, "0xa77028cd034fae57dd4acb50ebcb9c074d569e64");
  assert.equal(r.verdict.claim.block, 26254525);
  const text = renderText(r);
  assert.match(text, /unlost\.eth/);
  assert.match(text, /nothing is owed/);
});

test("Arbitrum, rETH through the standard gateway, claimed by its own recipient 6.5 days later", async () => {
  const r = await replay("arb-claimed-by-recipient");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "rETH");
  assert.equal(r.verdict.claim.by, r.facts.asset.to);
  assert.ok(!r.verdict.notes.some((n) => /owed/.test(n)));
});

test("Arbitrum, Sep 2026, 0.0049 ETH confirmed and never claimed: anyone can claim, with a proof that checks out", async () => {
  const r = await replay("arb-ready-eth");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.confirmed.sendCount, 167052);
  assert.equal(r.facts.proof.hashes.length, 18);
  assert.equal(r.facts.proof.leafMatches, true);
  assert.equal(r.facts.proof.rootConfirmed, true);
  assert.match(r.verdict.action, /executeTransaction\(.*166450, 0xeac528b30a19023b3afb54836495d8b24d2aeecb/);
});

test("Arbitrum, 12 Oct, 119 weETH through the standard gateway, confirmed and not claimed", async () => {
  const r = await replay("arb-ready-erc20");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "weETH");
  assert.equal(r.facts.asset.decimals, 18);
  assert.equal(r.facts.asset.to, "0x6f923e527a9ac0fca4e4a14ee10778fbf0d8013c");
  assert.match(renderText(r), /119\.29175918 weETH/);
});

test("Arbitrum, started today, already in an assertion: claim opens when its window ends on 30 Oct", async () => {
  const r = await replay("arb-waiting");
  assert.equal(r.verdict.state, "WAITING_FOR_CONFIRMATION");
  assert.equal(r.facts.confirmed.covered, false);
  assert.equal(r.facts.covering.createdAtBlock, 26261754);
  assert.equal(r.facts.covering.deadlineBlock, 26261754 + 45818);
  assert.equal(r.verdict.eta, r.facts.l1.timestamp + (26261754 + 45818 - 26261887) * 12);
  assert.match(renderText(r), /2026-10-30/);
});

test("Arbitrum, wstETH through Lido's custom gateway, too new for any assertion: next assertion plus the window", async () => {
  const r = await replay("arb-waiting-no-assertion");
  assert.equal(r.verdict.state, "WAITING_FOR_CONFIRMATION");
  assert.equal(r.facts.covering, null);
  assert.equal(r.facts.asset.symbol, "wstETH");
  assert.equal(r.verdict.eta, r.facts.l1.timestamp + 3600 + 45818 * 12);
});

test("an ordinary Arbitrum transaction is not a withdrawal", async () => {
  const r = await replay("arb-not-a-withdrawal");
  assert.equal(r.error, "not-a-withdrawal");
});

// Linea, recorded on 24 Oct 2026 at finalized L1 block 26262206. The L1 rollup had finalized L2 blocks up to 32410600.

test("Linea, Oct 2026, 0.332 ETH finalized and not claimed: anyone can claim, with a rebuilt proof that checks out", async () => {
  const r = await replay("linea-ready-eth");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 332000000000000000n);
  assert.equal(r.facts.withdrawal.nonce, 108641n);
  assert.equal(r.facts.proof.hashes.length, 5);
  assert.equal(r.facts.proof.root, "0x0aeb2fafbe089e087dc4cff750c781c4a4c2b9650a686b0d5026f4ddb8cfcddd");
  assert.equal(r.facts.proof.rootConfirmed, true);
  assert.match(r.verdict.action, /claimMessageWithProof\(\{proof: 5 hashes, messageNumber: 108641, leafIndex: 0/);
});

test("Linea, 138,384 USDT through the canonical token bridge, finalized and not claimed", async () => {
  const r = await replay("linea-ready-erc20");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "USDT");
  assert.equal(r.facts.asset.decimals, 6);
  assert.equal(r.facts.asset.to, "0x22740deba78d5a0c24c58c740e3715ec29de1bfa");
  assert.equal(r.facts.proof.rootConfirmed, true);
  assert.match(renderText(r), /138384\.480511 USDT/);
});

test("Linea, Mar 2024, 0.05 ETH claimed by unlost.eth on 24 Oct 2026: done, and the claimer is named", async () => {
  const r = await replay("linea-claimed-by-unlost");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.withdrawal.legacy, false);
  assert.equal(r.verdict.claim.by, "0xa77028cd034fae57dd4acb50ebcb9c074d569e64");
  const text = renderText(r);
  assert.match(text, /unlost\.eth/);
  assert.match(text, /nothing is owed/);
});

test("Linea, 0.2168 ETH claimed by its own sender two days later", async () => {
  const r = await replay("linea-claimed-by-owner");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.verdict.claim.by, r.facts.asset.to);
  assert.ok(!r.verdict.notes.some((n) => /owed/.test(n)));
});

test("Linea, Feb 2024, before L2 block 2,242,568 and never claimed: the legacy claimMessage, no proof", async () => {
  const r = await replay("linea-legacy-ready");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.facts.withdrawal.legacy, true);
  assert.equal(r.facts.proof, null);
  assert.match(r.verdict.action, /^LineaRollup\.claimMessage\(0xee7790e4f4ba2d0fca89228313e08ada9689f16e, .*, 49941\)$/);
  assert.ok(r.verdict.notes.some((n) => /90 days/.test(n)));
});

test("an ordinary Linea transaction is not a withdrawal", async () => {
  const r = await replay("linea-not-a-withdrawal");
  assert.equal(r.error, "not-a-withdrawal");
});

// ZKsync Era, recorded on 24 Oct 2026 at finalized L1 blocks 26262270 to 26262302, when L1 had executed batches up to 519103.

test("ZKsync, started today, batch 519139 not executed yet: waiting, ETA from how long batches take now", async () => {
  const r = await replay("zksync-waiting");
  assert.equal(r.verdict.state, "WAITING_FOR_BATCH");
  assert.equal(r.facts.batch.number, 519139);
  assert.equal(r.facts.batch.executed, false);
  const l = r.facts.latest;
  assert.equal(r.verdict.eta, r.facts.batch.committedAt + (l.executedAt - l.committedAt));
  assert.equal(r.facts.asset.amount, 3202864563392798n);
  assert.match(r.verdict.summary, /automatically/);
});

test("ZKsync, Mar 2025, 0.0247 ETH never finalized: anyone can finalize, and a dry run of the call on L1 succeeds", async () => {
  const r = await replay("zksync-ready");
  assert.equal(r.verdict.state, "READY_TO_FINALIZE");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.withdrawal.index, 2);
  assert.equal(r.facts.proof.hashes.length, 16);
  assert.equal(r.facts.proof.simulated, true);
  assert.match(r.verdict.action, /^L1Nullifier\.finalizeDeposit\(\{chainId: 324, l2BatchNumber: 498011, l2MessageIndex: 2, l2Sender: 0x0+800a, l2TxNumberInBatch: 2242/);
  assert.match(renderText(r), /dry run of the call on L1 succeeded/);
});

test("ZKsync, Dec 2025, a batch settled through Gateway: a 34-hash proof that still finalizes on L1", async () => {
  const r = await replay("zksync-ready-gateway");
  assert.equal(r.verdict.state, "READY_TO_FINALIZE");
  assert.equal(r.facts.proof.hashes.length, 34);
  assert.equal(r.facts.proof.simulated, true);
});

test("ZKsync, finalized automatically through the WithdrawalFinalizer contract", async () => {
  const r = await replay("zksync-finalized-by-finalizer");
  assert.equal(r.verdict.state, "FINALIZED");
  assert.equal(r.facts.finalizedBy, "nullifier");
  assert.equal(r.verdict.claim.via, "0xf8a16864d8de145a266a534174305f881ee2315e");
  assert.ok(r.verdict.notes.some((n) => /WithdrawalFinalizer/.test(n)));
  assert.ok(!r.verdict.notes.some((n) => /owed/.test(n)));
});

test("ZKsync, Jun 2024, 0.339 ETH finalized by unlost.eth on 24 Oct 2026, among four for the same recipient in one block", async () => {
  const r = await replay("zksync-finalized-by-unlost");
  assert.equal(r.verdict.state, "FINALIZED");
  assert.equal(r.verdict.claim.by, "0xa77028cd034fae57dd4acb50ebcb9c074d569e64");
  const text = renderText(r);
  assert.match(text, /finalized 2026-10-24 .*unlost\.eth/);
  assert.match(text, /nothing is owed/);
});

test("ZKsync, USDC through the asset router: the token comes from the native token vault on L1", async () => {
  const r = await replay("zksync-finalized-usdc");
  assert.equal(r.verdict.state, "FINALIZED");
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "USDC");
  assert.equal(r.facts.asset.l1Token, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.match(renderText(r), /539\.022646 USDC/);
  assert.equal(r.verdict.claim.by, r.facts.asset.to);
});

test("ZKsync, rETH through the legacy L2 bridge message format", async () => {
  const r = await replay("zksync-finalized-legacy-bridge");
  assert.equal(r.verdict.state, "FINALIZED");
  assert.equal(r.facts.asset.symbol, "rETH");
  assert.equal(r.facts.withdrawal.sender, "0x11f943b2c77b743ab90f4a0ae7d5a4e7fca3e102");
});

test("an ordinary ZKsync transaction is not a withdrawal", async () => {
  const r = await replay("zksync-not-a-withdrawal");
  assert.equal(r.error, "not-a-withdrawal");
});

test("auto-detection finds Linea and ZKsync withdrawals when the other chains do not have the transaction", async () => {
  for (const [name, id] of [["linea-ready-eth", "linea"], ["zksync-ready", "zksync"]]) {
    const fx = load(name);
    const nowhere = { l1: async () => { throw new Error("no L1 read expected"); }, l2: async () => null };
    const r = await check(fx.tx, { clients: (c) => (c.id === id ? { l1: replaying(fx.store.l1), l2: replaying(fx.store.l2) } : nowhere) });
    assert.equal(r.chain.id, id);
    assert.equal(r.verdict.who, "anyone");
  }
});

test("auto-detection finds an Arbitrum withdrawal after OP Mainnet and Base say they do not have it", async () => {
  const fx = load("arb-ready-eth");
  const nowhere = { l1: async () => { throw new Error("no L1 read expected"); }, l2: async () => null };
  const r = await check(fx.tx, { clients: (c) => (c.id === "arb" ? { l1: replaying(fx.store.l1), l2: replaying(fx.store.l2) } : nowhere) });
  assert.equal(r.chain.id, "arb");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
});

test("auto-detection asks every chain at once: a chain whose RPC never answers does not hold up the others", { timeout: 5000 }, async () => {
  const fx = load("arb-ready-eth");
  const hang = { l1: () => new Promise(() => {}), l2: () => new Promise(() => {}) };
  const r = await check(fx.tx, { clients: (c) => (c.id === "arb" ? { l1: replaying(fx.store.l1), l2: replaying(fx.store.l2) } : hang) });
  assert.equal(r.chain.id, "arb");
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
});

test("auto-detection: a chain whose RPCs fail does not hide a withdrawal found on another", async () => {
  const fx = load("arb-ready-eth");
  const down = { l1: async () => { throw new Error("down"); }, l2: async () => { throw new Error("down"); } };
  const r = await check(fx.tx, { clients: (c) => (c.id === "arb" ? { l1: replaying(fx.store.l1), l2: replaying(fx.store.l2) } : down) });
  assert.equal(r.chain.id, "arb");
});

test("auto-detection: no chain has it, or the only answers are failures", async () => {
  const tx = "0x" + "ab".repeat(32);
  const nowhere = { l1: async () => null, l2: async () => null };
  assert.equal((await check(tx, { clients: () => nowhere })).error, "not-found");
  const down = { l1: async () => { throw new Error("down"); }, l2: async () => { throw new Error("down"); } };
  await assert.rejects(check(tx, { clients: (c) => (c.id === "op" ? down : nowhere) }), /down/);
});

test("with deferExtras the verdict comes first and does not wait on the archive search for the claimer", { timeout: 5000 }, async () => {
  const fx = load("arb-claimed-by-unlost");
  let release;
  const gate = new Promise((ok) => (release = ok));
  const slow = async (m, p) => { await gate; return replaying(fx.store.l1)(m, p); };
  const r = await check(fx.tx, { chain: "arb", deferExtras: true, clients: () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2), l1Archive: slow }) });
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.claimLookup, "pending");
  assert.equal(r.verdict.claim, null);
  release();
  const full = await r.extras;
  assert.equal(full.verdict.claim.by, "0xa77028cd034fae57dd4acb50ebcb9c074d569e64");
  assert.equal(full.facts.claimLookup, null);
  assert.match(renderText(full), /unlost\.eth/);
});

test("ZKsync with deferExtras: the verdict comes first and does not wait on the archive search for the finalizer", { timeout: 5000 }, async () => {
  const fx = load("zksync-finalized-by-unlost");
  let release;
  const gate = new Promise((ok) => (release = ok));
  const slow = async (m, p) => { await gate; return replaying(fx.store.l1)(m, p); };
  const r = await check(fx.tx, { chain: "zksync", deferExtras: true, clients: () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2), l1Archive: slow }) });
  assert.equal(r.verdict.state, "FINALIZED");
  assert.equal(r.facts.claimLookup, "pending");
  assert.equal(r.verdict.claim, null);
  assert.ok(!r.verdict.notes.some((n) => /Could not find/.test(n)));
  release();
  const full = await r.extras;
  assert.equal(full.verdict.claim.by, "0xa77028cd034fae57dd4acb50ebcb9c074d569e64");
  assert.equal(full.facts.claimLookup, null);
  assert.match(renderText(full), /finalized 2026-10-24 .*unlost\.eth/);
});

test("without deferExtras (the CLI) everything is read before the answer, and there is nothing left over", async () => {
  const r = await replay("arb-claimed-by-unlost");
  assert.equal(r.extras, undefined);
  assert.equal(r.verdict.claim.by, "0xa77028cd034fae57dd4acb50ebcb9c074d569e64");
});

test("a malformed hash is refused before any network call", async () => {
  const r = await check("0x1234", { clients: () => { throw new Error("no network expected"); } });
  assert.equal(r.error, "bad-hash");
});
