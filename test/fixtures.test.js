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

test("without deferExtras (the CLI) everything is read before the answer, and there is nothing left over", async () => {
  const r = await replay("arb-claimed-by-unlost");
  assert.equal(r.extras, undefined);
  assert.equal(r.verdict.claim.by, "0xa77028cd034fae57dd4acb50ebcb9c074d569e64");
});

test("a malformed hash is refused before any network call", async () => {
  const r = await check("0x1234", { clients: () => { throw new Error("no network expected"); } });
  assert.equal(r.error, "bad-hash");
});
