// Who sent an Arbitrum claim, against a fake archive endpoint: the search must stay inside small log ranges, find the
// log whose transactionIndex is this withdrawal's position, and never name anyone it did not find.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimOf } from "../src/arbitrum.js";
import { word } from "../src/abi.js";

const OUTBOX = "0x0b9857ae2d4a3dbe74ffe1d7df045bb7f96e4840";
const TARGET = "0x" + "aa".repeat(20);
const SENDER = "0x" + "bb".repeat(20);
const CLAIMER = "0x" + "cc".repeat(20);
const POSITION = 44574;
const num = (h) => Number(BigInt(h));

const facts = (over = {}) => ({
  withdrawal: { position: POSITION, target: TARGET, sender: SENDER, ethBlockNum: 16_000_000 },
  contracts: { outbox: OUTBOX },
  config: { confirmPeriodBlocks: 45_818 },
  l1: { block: 26_262_142 },
  ...over,
});

const execLog = (block, position, tx = "0x" + "11".repeat(32)) => ({
  address: OUTBOX,
  blockNumber: "0x" + block.toString(16),
  blockTimestamp: "0x6adb2d37",
  transactionHash: tx,
  topics: ["0x20af7f3bbfe38132b8900ae295cd9c8d1914be7052d061a511f3f728dab18964", "0x" + word(TARGET), "0x" + word(SENDER), "0x" + word(0)],
  data: "0x" + word(position),
});

/** An archive endpoint where the position turns spent at `claimBlock`, holding `logs`. It records every call. */
function archive({ claimBlock, logs, maxRange = 10_000 }) {
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_call") return "0x" + word(num(params[1]) >= claimBlock ? 1 : 0);
    if (method === "eth_getLogs") {
      const { fromBlock, toBlock, address, topics } = params[0];
      if (num(toBlock) - num(fromBlock) + 1 > maxRange) throw new Error("range too large");
      return logs.filter((l) => l.address === address && l.topics[1] === topics[1] && l.topics[2] === topics[2] && num(l.blockNumber) >= num(fromBlock) && num(l.blockNumber) <= num(toBlock));
    }
    if (method === "eth_getTransactionByHash") return { from: CLAIMER.toUpperCase().replace("0X", "0x") };
    throw new Error(`unexpected ${method}`);
  };
  return { call, calls };
}

const logCalls = (calls) => calls.filter((c) => c.method === "eth_getLogs");

test("a claim made recently is found in the newest window, with no history search", async () => {
  const a = archive({ claimBlock: 26_254_525, logs: [execLog(26_254_525, POSITION)] });
  const r = await claimOf(facts(), { l1Archive: a.call });
  assert.equal(r.claimLookup, null);
  assert.deepEqual(r.claim, { by: CLAIMER, txHash: "0x" + "11".repeat(32), block: 26_254_525, timestamp: 0x6adb2d37 });
  assert.ok(logCalls(a.calls).every((c) => num(c.params[0].toBlock) - num(c.params[0].fromBlock) < 10_000));
});

test("a claim made as soon as the window opened is found in the oldest window", async () => {
  const opens = 16_000_000 + 45_818;
  const a = archive({ claimBlock: opens + 300, logs: [execLog(opens + 300, POSITION)] });
  const r = await claimOf(facts(), { l1Archive: a.call });
  assert.equal(r.claim.block, opens + 300);
});

test("a claim in the middle of three years is narrowed by isSpent on old state, then read from one small log range", async () => {
  const claimBlock = 20_123_457;
  const other = execLog(20_123_000, POSITION + 1, "0x" + "22".repeat(32)); // same gateway pair, another withdrawal
  const a = archive({ claimBlock, logs: [other, execLog(claimBlock, POSITION)] });
  const r = await claimOf(facts(), { l1Archive: a.call });
  assert.equal(r.claim.block, claimBlock);
  assert.equal(r.claim.txHash, "0x" + "11".repeat(32));
  const probes = a.calls.filter((c) => c.method === "eth_call");
  assert.ok(probes.length <= 4 * 15, `${probes.length} isSpent probes`);
  assert.ok(logCalls(a.calls).every((c) => num(c.params[0].toBlock) - num(c.params[0].fromBlock) < 10_000));
});

test("logs from the same pair for other positions are never taken for this claim", async () => {
  const a = archive({ claimBlock: 26_254_525, logs: [execLog(26_254_525, POSITION + 7)] });
  const r = await claimOf(facts(), { l1Archive: a.call });
  assert.equal(r.claim, null);
  assert.equal(r.claimLookup, "not-found");
});

test("no archive endpoint answers: could not tell, and nobody is named", async () => {
  const r = await claimOf(facts(), { l1Archive: async () => { throw new Error("archive requests need a token"); } });
  assert.equal(r.claim, null);
  assert.equal(r.claimLookup, "failed");
});

test("without a separate archive client the L1 client is used", async () => {
  const a = archive({ claimBlock: 26_254_525, logs: [execLog(26_254_525, POSITION)] });
  const r = await claimOf(facts(), { l1: a.call });
  assert.equal(r.claim.by, CLAIMER);
});
