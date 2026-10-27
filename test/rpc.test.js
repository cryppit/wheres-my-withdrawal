import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRpc } from "../src/rpc.js";

const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
const busy = { ok: false, status: 429, json: async () => ({}) };

test("an endpoint that answers 429 (too many requests) is asked again after a pause, before the next one", async () => {
  const seen = [];
  const answers = [busy, busy, ok("0x1")];
  const call = makeRpc(["https://a.example", "https://b.example"], {
    fetch: async (url) => (seen.push(new URL(url).host), answers.shift()),
    sleep: async () => {},
  });
  assert.equal(await call("eth_blockNumber", []), "0x1");
  assert.deepEqual(seen, ["a.example", "a.example", "a.example"]);
});

test("an endpoint that stays busy gives way to the next one", async () => {
  const seen = [];
  const call = makeRpc(["https://a.example", "https://b.example"], {
    fetch: async (url) => (seen.push(new URL(url).host), new URL(url).host === "a.example" ? busy : ok("0x2")),
    sleep: async () => {},
  });
  assert.equal(await call("eth_blockNumber", []), "0x2");
  assert.deepEqual(seen, ["a.example", "a.example", "a.example", "b.example"]);
});
