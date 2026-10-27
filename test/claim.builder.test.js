import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeArbitrumClaim, encodeLineaClaim, encodeLineaLegacyClaim } from "../src/claim.js";

const h = (b) => "0x" + b.repeat(32);

// The reference encodings were made with eth_abi 5.2.0, not with this code.
test("Outbox.executeTransaction is encoded exactly as eth_abi encodes it", () => {
  const w = { position: 44574, sender: "0x09e9222E96E7B4AE2a407B98d48e330053351EEe", target: "0x1111111111111111111111111111111111111111", arbBlockNum: 123456789, ethBlockNum: 20000000, timestamp: 1700000000, value: 10n ** 17n, data: "0x2e567b36" + "ab".repeat(40) };
  assert.equal(
    encodeArbitrumClaim([h("aa"), h("bb"), h("cc")], w),
    "0x08635a950000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000ae1e00000000000000000000000009e9222e96e7b4ae2a407b98d48e330053351eee000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000075bcd150000000000000000000000000000000000000000000000000000000001312d00000000000000000000000000000000000000000000000000000000006553f100000000000000000000000000000000000000000000000000016345785d8a000000000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000000000003aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc000000000000000000000000000000000000000000000000000000000000002c2e567b36abababababababababababababababababababababababababababababababababababababababab0000000000000000000000000000000000000000",
  );
});

test("Linea claimMessageWithProof is encoded exactly as eth_abi encodes it (fee to the sender of the claim: feeRecipient 0)", () => {
  const w = { nonce: 98765n, from: "0x353012dc4a9a6cf55c941badc267f82004a8ceb9", to: "0x051f1d88f0af5763fb888ec4378b4d8b29ea3319", fee: 0n, value: 10n ** 15n, data: "0x5ad0" + "ab".repeat(20) };
  const proof = { hashes: [h("aa"), h("bb")], leafIndex: 5, root: h("dd") };
  assert.equal(
    encodeLineaClaim(proof, w),
    "0x6463fb2a0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000181cd0000000000000000000000000000000000000000000000000000000000000005000000000000000000000000353012dc4a9a6cf55c941badc267f82004a8ceb9000000000000000000000000051f1d88f0af5763fb888ec4378b4d8b29ea3319000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000000dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd00000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000000000002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00000000000000000000000000000000000000000000000000000000000000165ad0abababababababababababababababababababab00000000000000000000",
  );
});

test("Linea's legacy claimMessage (messages before Alpha v2) is encoded exactly as eth_abi encodes it", () => {
  const w = { nonce: 4242n, from: "0x2222222222222222222222222222222222222222", to: "0x3333333333333333333333333333333333333333", fee: 1000n, value: 5n * 10n ** 17n, data: "0x" };
  assert.equal(
    encodeLineaLegacyClaim(w),
    "0x491e09360000000000000000000000002222222222222222222222222222222222222222000000000000000000000000333333333333333333333333333333333333333300000000000000000000000000000000000000000000000000000000000003e800000000000000000000000000000000000000000000000006f05b59d3b20000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e000000000000000000000000000000000000000000000000000000000000010920000000000000000000000000000000000000000000000000000000000000000",
  );
});

// The builder end to end on recorded withdrawals (fixtures), with the rehearsal's eth_call stubbed to succeed.
import { readFileSync } from "node:fs";
import { buildClaim } from "../src/claim.js";
import { replaying } from "../src/rpc.js";
import { CHAINS } from "../src/chains.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
const passes = async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) });
async function build(name) {
  const fx = fixture(name);
  return buildClaim(CHAINS[fx.chain], fx.tx, { index: fx.index, clients: () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2) }), doFetch: passes });
}

test("buildClaim on a ready Arbitrum withdrawal: executeTransaction on the Outbox with the checked proof", async () => {
  const c = await build("arb-ready-eth");
  assert.equal(c.call.to, "0x0b9857ae2d4a3dbe74ffe1d7df045bb7f96e4840");
  assert.ok(c.call.data.startsWith("0x08635a95"));
  assert.equal(c.rehearsal.ok, true);
});

test("buildClaim on a legacy Linea message: claimMessage on the rollup", async () => {
  const c = await build("linea-legacy-ready");
  assert.equal(c.call.to, CHAINS.linea.rollup);
  assert.ok(c.call.data.startsWith("0x491e0936"));
});

test("buildClaim on a Linea message with a rebuilt proof: claimMessageWithProof", async () => {
  const c = await build("linea-ready-eth");
  assert.ok(c.call.data.startsWith("0x6463fb2a"));
});

test("buildClaim refuses a withdrawal that is not ready, and an OP Stack chain", async () => {
  assert.equal((await build("arb-waiting")).error, "not-ready");
  assert.equal((await buildClaim(CHAINS.op, "0x" + "00".repeat(32))).error, "bad-chain");
});
