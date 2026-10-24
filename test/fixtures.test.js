// Real withdrawals, replayed from the RPC answers recorded on 24 Oct 2026 (scripts/record.mjs). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "../src/check.js";
import { replaying } from "../src/rpc.js";
import { renderText } from "../src/render.js";

async function replay(name) {
  const fx = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
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

test("a malformed hash is refused before any network call", async () => {
  const r = await check("0x1234", { clients: () => { throw new Error("no network expected"); } });
  assert.equal(r.error, "bad-hash");
});
