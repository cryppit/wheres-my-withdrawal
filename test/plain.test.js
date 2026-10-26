// The plain-language box: what a result means for someone who has never heard of proving, dispute games or outboxes.
// Every recorded real withdrawal must get one, in words without jargon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { check } from "../src/check.js";
import { replaying } from "../src/rpc.js";
import { plainNext } from "../src/plain.js";

const replay = async (name) => {
  const fx = JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
  return check(fx.tx, { chain: fx.chain, index: fx.index, clients: () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2) }) });
};
const text = (p) => [p.headline, ...p.steps].join("\n");
const JARGON = /dispute|calldata|merkle|nonce|portal|outbox|\bL1\b|\bL2\b|relayMessage|assertion|batch root|proof submitter|0x[0-9a-f]{64}/i;

test("pre-Bedrock OP withdrawal, ready to prove: safe, two steps, 7 days apart, anyone can send them, money only to the owner", async () => {
  const p = plainNext(await replay("op-2022-pre-bedrock"));
  assert.match(p.headline, /waiting/i);
  const t = text(p);
  assert.match(t, /doesn't expire/);
  assert.match(t, /Step 1 of 2/);
  assert.match(t, /7 days/);
  assert.match(t, /0xd355d58dc7d94228add92b38903bdfe008e12451/);
  assert.match(t, /seed phrase/);
  assert.match(t, /before June 2023/);
});

test("proven OP withdrawal: nothing to do until the date it opens; nobody is owed a tip", async () => {
  const p = plainNext(await replay("op-proven-by-unlost"));
  assert.match(p.headline, /proven/i);
  assert.match(text(p), /2026-10-31/);
  assert.match(text(p), /owe/i);
});

test("finished withdrawals say the money arrived, on Ethereum", async () => {
  for (const n of ["op-finalized", "base-finalized", "arb-claimed-by-recipient", "linea-claimed-by-owner", "zksync-finalized-by-finalizer", "robinhood-claimed-eth"]) {
    const p = plainNext(await replay(n));
    assert.match(p.headline, /arrived/i, n);
    assert.match(text(p), /Ethereum/, n);
  }
});

test("Arbitrum and Linea ready ones name the one last step, the claim", async () => {
  for (const n of ["arb-ready-eth", "linea-ready-eth", "robinhood-ready-erc20"]) assert.match(text(plainNext(await replay(n))), /claim/i, n);
});

test("waiting ones say there is nothing to do yet", async () => {
  for (const n of ["arb-waiting", "robinhood-waiting-eth", "zksync-waiting"]) assert.match(text(plainNext(await replay(n))), /Nothing to do yet/, n);
});

test("every recorded withdrawal gets a headline and steps, with no jargon", async () => {
  for (const f of readdirSync(new URL("../fixtures/", import.meta.url))) {
    const r = await replay(f.replace(".json", ""));
    if (r.error) continue;
    const p = plainNext(r);
    assert.ok(p.headline && p.steps.length > 0, f);
    assert.doesNotMatch(text(p).replace(/0x[0-9a-f]{40}\b/gi, "ADDR"), JARGON, f);
  }
});
