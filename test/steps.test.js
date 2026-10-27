import { test } from "node:test";
import assert from "node:assert/strict";
import { stepsOf } from "../src/steps.js";

const states = (stack, state) => stepsOf(stack, { state }).map((s) => s.state);
const titles = (stack) => stepsOf(stack, { state: "FINALIZED" }).map((s) => s.title);

test("an OP Stack withdrawal has four stops: started, proven, the challenge window, finalized", () => {
  assert.deepEqual(titles("op"), ["Started", "Prove", "Safety wait", "Finalize on Ethereum"]);
  assert.deepEqual(states("op", "FINALIZED"), ["done", "done", "done", "done"]);
  assert.deepEqual(states("op", "READY_TO_PROVE"), ["done", "next", "not_reached", "not_reached"]);
  assert.deepEqual(states("op", "WAITING_FOR_GAME"), ["done", "waiting", "not_reached", "not_reached"]);
  assert.deepEqual(states("op", "WAITING_TO_FINALIZE"), ["done", "done", "waiting", "not_reached"]);
  assert.deepEqual(states("op", "READY_TO_FINALIZE"), ["done", "done", "done", "next"]);
  assert.deepEqual(states("op", "RELAY_FAILED"), ["done", "done", "done", "stopped"]);
});

test("Arbitrum and Linea wait for L1, then anyone claims", () => {
  assert.deepEqual(titles("arbitrum"), ["Started", "Confirmed on Ethereum", "Claim"]);
  assert.deepEqual(states("arbitrum", "WAITING_FOR_CONFIRMATION"), ["done", "waiting", "not_reached"]);
  assert.deepEqual(states("arbitrum", "READY_TO_CLAIM"), ["done", "done", "next"]);
  assert.deepEqual(states("arbitrum", "CLAIMED"), ["done", "done", "done"]);
  assert.deepEqual(titles("linea"), ["Started", "Confirmed on Ethereum", "Claim"]);
  assert.deepEqual(states("linea", "WAITING_FOR_FINALIZATION"), ["done", "waiting", "not_reached"]);
});

test("ZKsync waits for its batch to execute, then the finalize step", () => {
  assert.deepEqual(titles("zksync"), ["Started", "Confirmed on Ethereum", "Finalize"]);
  assert.deepEqual(states("zksync", "WAITING_FOR_BATCH"), ["done", "waiting", "not_reached"]);
  assert.deepEqual(states("zksync", "READY_TO_FINALIZE"), ["done", "done", "next"]);
  assert.deepEqual(states("zksync", "FINALIZED"), ["done", "done", "done"]);
});

test("a waiting stop carries when it opens", () => {
  const [, , window] = stepsOf("op", { state: "WAITING_TO_FINALIZE", eta: 1_800_000_000 });
  assert.equal(window.eta, 1_800_000_000);
});
