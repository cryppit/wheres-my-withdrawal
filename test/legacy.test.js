// Withdrawals started before OP Mainnet's Bedrock upgrade (June 2023): the upgrade carried every unrelayed one over
// as a new-style withdrawal, rebuilt here the way op-chain-ops/crossdomain/migrate.go (v1.1.4) did. The case is a real
// one: 0.01798 ETH from December 2022 (optimism#23551), whose rebuilt hash L2ToL1MessagePasser.sentMessages confirms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { legacyWithdrawalsIn, migrationGasLimit, assetOf } from "../src/opstack.js";
import { CHAINS } from "../src/chains.js";

const fx = JSON.parse(readFileSync(new URL("../fixtures/op-2022-pre-bedrock.json", import.meta.url)));
const receipt = Object.values(fx.store.l2).find((v) => v && v.logs && v.transactionHash?.toLowerCase() === fx.tx.toLowerCase());

test("migrationGasLimit: 16 gas per byte of relayMessage data plus the fixed 1,300,873 overhead, capped at 25M", () => {
  assert.equal(migrationGasLimit(420), 1307593n);
  assert.equal(migrationGasLimit(0), 1300873n);
  assert.equal(migrationGasLimit(10_000_000), 25000000n);
});

test("a December 2022 OP withdrawal is rebuilt exactly as the Bedrock migration stored it", () => {
  const [w] = legacyWithdrawalsIn(receipt, CHAINS.op);
  assert.equal(w.nonce, 116402n);
  assert.equal(w.sender, "0x4200000000000000000000000000000000000007");
  assert.equal(w.target, CHAINS.op.l1Messenger);
  assert.equal(w.value, 17980000000000000n);
  assert.equal(w.gasLimit, 1307593n);
  assert.equal(w.hash, "0xd4b45b9d65cd6887388bc90334a922cf732554ec1acd0f244da2f873661ee3bc");
  assert.equal(w.legacy.sender, "0x4200000000000000000000000000000000000010");
});

test("its asset is the ETH the old bridge message names, going to the original recipient", () => {
  const [w] = legacyWithdrawalsIn(receipt, CHAINS.op);
  assert.deepEqual(assetOf(w, CHAINS.op), {
    kind: "eth",
    amount: 17980000000000000n,
    from: "0xd355d58dc7d94228add92b38903bdfe008e12451",
    to: "0xd355d58dc7d94228add92b38903bdfe008e12451",
  });
});

test("Base started after Bedrock: no legacy withdrawals are read there", () => {
  assert.deepEqual(legacyWithdrawalsIn(receipt, CHAINS.base), []);
});

test("the full check on it: ready to prove, by anyone, with a note on why bridge apps don't list it", async () => {
  const { check } = await import("../src/check.js");
  const { replaying } = await import("../src/rpc.js");
  const { renderText } = await import("../src/render.js");
  const r = await check(fx.tx, { chain: "op", clients: () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2) }) });
  assert.equal(r.verdict.state, "READY_TO_PROVE");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.withdrawal.hash, "0xd4b45b9d65cd6887388bc90334a922cf732554ec1acd0f244da2f873661ee3bc");
  assert.equal(r.facts.asset.to, "0xd355d58dc7d94228add92b38903bdfe008e12451");
  assert.equal(r.facts.legacy, true);
  assert.match(renderText(r), /before OP Mainnet's big upgrade of 6 June 2023/);
});

test("DERIVED, not recorded: had the old message been relayed (before or after the upgrade), it reads as done", async () => {
  const { check } = await import("../src/check.js");
  const { replaying } = await import("../src/rpc.js");
  const l1 = structuredClone(fx.store.l1);
  const key = Object.keys(l1).find((k) => k.includes("0x25ace71c97b33cc4729cf772ae268934f7ab5fa1") && k.includes("0xb1b1b209093c4f16"));
  l1[key] = "0x" + "0".repeat(63) + "1"; // successfulMessages(legacy hash) = true
  const r = await check(fx.tx, { chain: "op", clients: () => ({ l1: replaying(l1), l2: replaying(fx.store.l2) }) });
  assert.equal(r.verdict.state, "FINALIZED");
  assert.equal(r.facts.relay, "ok");
});
