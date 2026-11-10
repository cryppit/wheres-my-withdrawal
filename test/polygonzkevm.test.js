// Polygon zkEVM (the Polygon/AggLayer LxLy unified bridge — its own family, NOT OP Stack, NOT Scroll-style), replayed
// from RPC answers recorded on 10 Nov 2026 (scripts/record.mjs polygonzkevm …). No network. Before these fixtures were
// cut, EVERY piece was verified on chain (see src/polygonzkevm.js, src/chains.js):
//   - the PolygonZkEVMBridgeV2 is the SAME address on L1 and L2 (networkID 0 vs 1), and its polygonRollupManager() /
//     globalExitRootManager() name the manager and GER; the manager names the bridge back and its rollup exit root
//     equals the GER's lastRollupExitRoot();
//   - the leaf hash matches the bridge's own getLeafValue() pure function on chain (0x3e197043), and the depth-32
//     Merkle fold matches the bridge's own calculateRoot() pure function on chain (0x83f24403) — both pinned below;
//   - the claimAsset selector is 0xccaa2d11 and the claim is gated on the SAME on-chain check claimAsset makes:
//     globalExitRootManager.globalExitRootMap(keccak(mainnetExitRoot, rollupExitRoot)) != 0.
//
// Fixtures that are REAL mainnet withdrawals: polygonzkevm-claimed-eth, polygonzkevm-claimed-usdc and
// polygonzkevm-not-a-withdrawal. polygonzkevm-proof-unavailable-eth is a REAL unclaimed mainnet withdrawal recorded
// while Polygon's proof API (networkId=1) was in a backend outage (HTTP 503) — it proves the accuracy guard: with the
// proof unverifiable, WMW refuses to say "claimable" and reports WAITING, never a guess. The claimable / full-claim
// path is covered by a clearly-labelled SYNTHETIC end-to-end test whose Merkle fold is REAL keccak math (it folds to a
// rollup exit root that the mocked GER then confirms), plus a byte-stable encodeClaim regression pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check } from "../src/check.js";
import { replaying, replayingApi } from "../src/rpc.js";
import { renderText } from "../src/render.js";
import { buildClaim, encodePolygonClaim } from "../src/claim.js";
import { leafValue, calcRoot, globalExitRoot, withdrawalsIn } from "../src/polygonzkevm.js";
import { verdict } from "../src/verdict.js";
import { stepsOf } from "../src/steps.js";
import { selector, keccakHex } from "../src/abi.js";
import { CHAINS } from "../src/chains.js";

const load = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url)));
const clientsFrom = (fx) => () => ({ l1: replaying(fx.store.l1), l2: replaying(fx.store.l2), l1Archive: replaying(fx.store.l1), api: replayingApi(fx.store.api) });

async function replay(name) {
  const fx = load(name);
  return check(fx.tx, { chain: fx.chain, index: fx.index, clients: clientsFrom(fx) });
}

// ---- REAL mainnet fixtures -------------------------------------------------------------------------------------

test("Polygon zkEVM, 1 ETH claimed on Ethereum: done; the claim is recorded but its sender is not guessed", async () => {
  const r = await replay("polygonzkevm-claimed-eth");
  assert.equal(r.facts.chain, "polygonzkevm");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.claimed, true);
  assert.equal(r.facts.finalized, true);
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 1000000000000000000n);
  assert.equal(r.facts.asset.to, "0x33fc2046b56497c4644c23bf26ce06a913e70429");
  assert.equal(r.verdict.claim, null);
  // The unified bridge does not index claims per withdrawal, so WMW says so instead of attributing a random claimer.
  assert.ok(r.verdict.notes.some((n) => /does not index claims per withdrawal/.test(n)));
  const text = renderText(r);
  assert.match(text, /1 ETH/);
});

test("Polygon zkEVM, 14.970065 USDC claimed on Ethereum: done, ERC-20 named from L1", async () => {
  const r = await replay("polygonzkevm-claimed-usdc");
  assert.equal(r.verdict.state, "CLAIMED");
  assert.equal(r.facts.asset.kind, "erc20");
  assert.equal(r.facts.asset.symbol, "USDC");
  assert.equal(r.facts.asset.decimals, 6);
  assert.equal(r.facts.asset.amount, 14970065n);
  assert.equal(r.facts.asset.l1Token, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.match(renderText(r), /14\.970065 USDC/);
});

test("an ordinary Polygon zkEVM transaction is not a withdrawal", async () => {
  const r = await replay("polygonzkevm-not-a-withdrawal");
  assert.equal(r.error, "not-a-withdrawal");
});

test("Polygon zkEVM auto-detection finds the withdrawal when the other chains do not have the transaction", async () => {
  const fx = load("polygonzkevm-claimed-eth");
  const nowhere = { l1: async () => { throw new Error("no L1 read expected"); }, l2: async () => null };
  const mine = clientsFrom(fx)();
  const r = await check(fx.tx, { clients: (c) => (c.id === "polygonzkevm" ? mine : nowhere) });
  assert.equal(r.chain.id, "polygonzkevm");
  assert.equal(r.verdict.state, "CLAIMED");
});

test("ACCURACY GUARD: a REAL unclaimed withdrawal while Polygon's proof API is down (HTTP 503) is NOT called claimable", async () => {
  // Recorded live while the networkId=1 proof backend returned 503. The API throws on replay (no entry), so the reader
  // cannot verify the proof -> it must say WAITING, never READY_TO_CLAIM. "Unknown stays unknown."
  const r = await replay("polygonzkevm-proof-unavailable-eth");
  assert.equal(r.facts.chain, "polygonzkevm");
  assert.equal(r.facts.claimed, false);
  assert.equal(r.facts.finalized, false); // never set without an on-chain-confirmed proof
  assert.equal(r.verdict.state, "WAITING_FOR_FINALIZATION");
  assert.equal(r.verdict.who, null);
  assert.equal(r.verdict.action, null);
  assert.equal(r.facts.proofLookup, "failed");
  assert.ok(r.verdict.notes.some((n) => /couldn't reach Polygon's proof service/.test(n)));
  assert.equal(r.facts.asset.kind, "eth");
  assert.equal(r.facts.asset.amount, 1772429385944575n);
});

// ---- On-chain-verified encoding pins (the leaf hash and the Merkle fold match the bridge's own pure functions) ----

test("the leaf hash matches the bridge's on-chain getLeafValue (verified on chain 10 Nov 2026) and is pinned", () => {
  const fx = load("polygonzkevm-claimed-eth");
  const [w] = withdrawalsIn(fx.store.l2[`eth_getTransactionReceipt ["${fx.tx}"]`], CHAINS.polygonzkevm);
  assert.equal(w.depositCount, 62239);
  // Equal to PolygonZkEVMBridgeV2.getLeafValue(0, 0, 0x0, 0, 0x33fc…0429, 1e18, keccak256("")) read on chain.
  assert.equal(leafValue(w), "0x45d1793333c2ef9b1eef5e54a12c4d28b02004774f9666b5f938092ec06cdedd");
});

test("calcRoot folds exactly like the bridge's on-chain calculateRoot (verified on chain) — depth-32 fold pinned", () => {
  const leaf = "0x" + "11".repeat(32);
  const proof = Array.from({ length: 32 }, (_, i) => "0x" + (i + 1).toString(16).padStart(2, "0").repeat(32));
  // == PolygonZkEVMBridgeV2.calculateRoot(leaf, proof, 5) read on chain.
  assert.equal(calcRoot(leaf, 5, proof), "0x7b5da3626c9ba2c7296dd69c5e4cacba93ca294472262f7acaaca986ee915a67");
  assert.equal(calcRoot(leaf, 0, proof), "0x9a8c792a3fa3822911eb388b789d25e0c66ebe19a9763c5d5f934e5f0423383d");
  assert.equal(calcRoot(leaf, 0, proof.slice(0, 31)), null); // a proof that is not 32 nodes is refused
});

test("globalExitRoot is keccak256(mainnetExitRoot ++ rollupExitRoot) (GlobalExitRootLib)", () => {
  assert.equal(
    globalExitRoot("0x" + "aa".repeat(32), "0x" + "bb".repeat(32)),
    keccakHex("0x" + "aa".repeat(32) + "bb".repeat(32)),
  );
});

// ---- SYNTHETIC end-to-end: the full claim path and the on-chain re-verification guard --------------------------
// The withdrawal and the Merkle proofs are constructed, but the FOLD is REAL keccak math: the proofs fold to a rollup
// exit root, and the GER the reader checks is keccak(mainRoot, that rollupRoot). We then flip the mocked on-chain
// globalExitRootMap between "recorded" and "not recorded" to prove the reader trusts the API proof ONLY when the
// on-chain GER confirms it — exactly Scroll's discipline.

const ISCLAIMED = selector("isClaimed(uint32,uint32)");
const GER_MAP = selector("globalExitRootMap(bytes32)");
const ZERO = "0x" + "0".repeat(64);
const ONE = "0x" + "0".repeat(63) + "1";

function bridgeLog(w) {
  const pad = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const uint = (v) => BigInt(v).toString(16).padStart(64, "0");
  // BridgeEvent(uint8,uint32,address,uint32,address,uint256,bytes metadata,uint32 depositCount): metadata is dynamic
  // (offset in word 6), depositCount is word 7, metadata tail (empty here) at offset 0x100.
  const data =
    "0x" + uint(w.leafType) + uint(w.originNetwork) + pad(w.originAddress) + uint(w.destinationNetwork) +
    pad(w.destinationAddress) + uint(w.amount) + uint(0x100) + uint(w.depositCount) + uint(0);
  return { address: CHAINS.polygonzkevm.bridge, topics: ["0x501781209a1f8899323b96b4ef08b168df93e0a90c673d1e4cce39366cb62f9b"], data };
}

function syntheticClients({ gerRecorded }) {
  const w = { leafType: 0, originNetwork: 0, originAddress: "0x0000000000000000000000000000000000000000", destinationNetwork: 0, destinationAddress: "0x1111111111111111111111111111111111111111", amount: 10n ** 15n, depositCount: 12345, metadata: "0x" };
  const leaf = leafValue(w);
  const localProof = Array.from({ length: 32 }, (_, i) => "0x" + ("a" + (i % 16).toString(16)).repeat(32));
  const rollupProof = Array.from({ length: 32 }, (_, i) => "0x" + ("b" + (i % 16).toString(16)).repeat(32));
  const localRoot = calcRoot(leaf, w.depositCount, localProof);
  const rollupRoot = calcRoot(localRoot, 0, rollupProof); // == what the reader must recompute
  const mainRoot = "0x" + "cc".repeat(32);
  const ger = globalExitRoot(mainRoot, rollupRoot);
  const tx = "0x" + "fe".repeat(32);
  const receipt = { blockNumber: "0x100", logs: [bridgeLog(w)] };
  const l2 = async (m) => (m === "eth_getTransactionReceipt" ? receipt : m === "eth_getBlockByNumber" ? { number: "0x100", timestamp: "0x66a00000" } : null);
  // The GER map answers nonzero when the global exit root is recorded on L1, zero otherwise — the finalization truth.
  const l1b = async (m, p) => {
    if (m === "eth_getBlockByNumber") return { number: "0x200", timestamp: "0x66b00000" };
    if (m === "eth_call") {
      const d = p[0].data;
      if (d.startsWith(ISCLAIMED)) return ZERO;
      if (d.startsWith(GER_MAP)) return gerRecorded ? ONE : ZERO;
    }
    return null;
  };
  const api = async () => ({ merkle_proof: localProof, rollup_merkle_proof: rollupProof, main_exit_root: mainRoot, rollup_exit_root: rollupRoot });
  return { tx, clients: () => ({ l1: l1b, l2, l1Archive: l1b, api }), expect: { leaf, rollupRoot, ger } };
}

test("SYNTHETIC: proof folds AND the GER is recorded on L1 -> READY_TO_CLAIM, full claimAsset built", async () => {
  const s = syntheticClients({ gerRecorded: true });
  const r = await check(s.tx, { chain: "polygonzkevm", clients: s.clients });
  assert.equal(r.verdict.state, "READY_TO_CLAIM");
  assert.equal(r.verdict.who, "anyone");
  assert.equal(r.facts.finalized, true);
  assert.equal(r.facts.proof.proofFolds, true);
  assert.equal(r.facts.proof.gerRecorded, true);
  assert.equal(r.facts.proof.rootConfirmed, true);
  assert.equal(r.facts.proof.computedRollupRoot, s.expect.rollupRoot);
  assert.equal(r.facts.proof.globalExitRoot, s.expect.ger);
  assert.match(r.verdict.action, /claimAsset/);
  assert.doesNotMatch(r.verdict.action, /bridge app/i);
  // buildClaim produces the real claimAsset calldata (selector 0xccaa2d11), rehearsal passes with a mocked RPC.
  const passes = async () => ({ json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" }) });
  const c = await buildClaim(CHAINS.polygonzkevm, s.tx, { clients: s.clients, doFetch: passes });
  assert.equal(c.call.to, CHAINS.polygonzkevm.bridge);
  assert.ok(c.call.data.startsWith("0xccaa2d11"));
  assert.equal(c.rehearsal.ok, true);
});

test("ACCURACY GUARD (SYNTHETIC): proof folds but the GER is NOT recorded on L1 -> NOT claimable", async () => {
  const s = syntheticClients({ gerRecorded: false });
  const r = await check(s.tx, { chain: "polygonzkevm", clients: s.clients });
  assert.equal(r.facts.proof.proofFolds, true); // the proof is internally consistent …
  assert.equal(r.facts.proof.gerRecorded, false); // … but its global exit root is not on L1
  assert.equal(r.facts.proof.rootConfirmed, false);
  assert.equal(r.facts.finalized, false);
  assert.equal(r.verdict.state, "WAITING_FOR_FINALIZATION");
  assert.equal(r.verdict.who, null);
  assert.equal(r.verdict.action, null);
  assert.ok(r.verdict.notes.some((n) => /not recorded on Ethereum yet/.test(n)));
});

test("encodePolygonClaim is a byte-stable claimAsset encoding (regression pin)", () => {
  const proof = {
    smtProofLocalExitRoot: Array.from({ length: 32 }, (_, i) => "0x" + (i).toString(16).padStart(2, "0").repeat(32)),
    smtProofRollupExitRoot: Array.from({ length: 32 }, (_, i) => "0x" + (i + 32).toString(16).padStart(2, "0").repeat(32)),
    globalIndex: 12345n,
    mainnetExitRoot: "0x" + "cc".repeat(32),
    rollupExitRoot: "0x" + "dd".repeat(32),
  };
  const w = { originNetwork: 0, originAddress: "0x0000000000000000000000000000000000000000", destinationNetwork: 0, destinationAddress: "0x1111111111111111111111111111111111111111", amount: 10n ** 15n, metadata: "0x" };
  const data = encodePolygonClaim(proof, w);
  assert.ok(data.startsWith("0xccaa2d11"));
  // 4 (selector) + 32 + 32 words proofs + globalIndex + 2 roots + 2 networks + 2 addresses + amount + metadata offset
  // + metadata length = (4) + (73 + 1) words. Empty metadata -> one length word (0).
  assert.equal(data.length, 2 + 8 + (73 + 1) * 64);
  assert.equal(data, PINNED_CLAIM);
});

const PINNED_CLAIM =
  "0xccaa2d11" +
  Array.from({ length: 32 }, (_, i) => (i).toString(16).padStart(2, "0").repeat(32)).join("") +
  Array.from({ length: 32 }, (_, i) => (i + 32).toString(16).padStart(2, "0").repeat(32)).join("") +
  "0000000000000000000000000000000000000000000000000000000000003039" + // globalIndex 12345
  "cc".repeat(32) + "dd".repeat(32) +
  "0000000000000000000000000000000000000000000000000000000000000000" + // originNetwork 0
  "0000000000000000000000000000000000000000000000000000000000000000" + // originTokenAddress 0x0
  "0000000000000000000000000000000000000000000000000000000000000000" + // destinationNetwork 0
  "0000000000000000000000001111111111111111111111111111111111111111" + // destinationAddress
  "00000000000000000000000000000000000000000000000000038d7ea4c68000" + // amount 1e15
  "0000000000000000000000000000000000000000000000000000000000000920" + // metadata offset (73*32)
  "0000000000000000000000000000000000000000000000000000000000000000";  // metadata length 0

// ---- Pure verdict/steps coverage for the not-yet-verified stage (no network, clearly SYNTHETIC) ----------------
test("Polygon zkEVM, not yet verified on Ethereum (SYNTHETIC): waiting, nothing to do", () => {
  const f = {
    stack: "polygonzkevm",
    l1: { timestamp: 1_700_000_000, block: 1 },
    asset: { kind: "eth", amount: 10n ** 16n, to: "0x1111111111111111111111111111111111111111" },
    withdrawal: { hash: "0x" + "ab".repeat(32), originNetwork: 0, originAddress: "0x0", destinationNetwork: 0, destinationAddress: "0x1", amount: 0n },
    finalized: false, claimed: false, proof: null, proofLookup: "not-found",
  };
  const v = verdict(f);
  assert.equal(v.state, "WAITING_FOR_FINALIZATION");
  assert.equal(v.who, null);
  assert.equal(v.action, null);
  assert.match(v.summary, /verify|zk proof/i);
  const steps = stepsOf("polygonzkevm", v);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].state, "done"); // Started
  assert.equal(steps[1].state, "waiting"); // Verified on Ethereum
  assert.equal(steps[2].title, "Claim");
});
