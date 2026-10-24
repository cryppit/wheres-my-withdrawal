#!/usr/bin/env node
// Record the real RPC answers for one check into fixtures/<name>.json, so tests replay them offline.
// Usage: node scripts/record.mjs <name> <chain> <L2 tx hash> [index]
import { writeFileSync } from "node:fs";
import { check, clientsFor } from "../src/check.js";
import { recording } from "../src/rpc.js";
import { CHAINS } from "../src/chains.js";
import { renderText } from "../src/render.js";

const [name, chain, tx, index = "0"] = process.argv.slice(2);
if (!name || !CHAINS[chain] || !tx) {
  console.error("Usage: node scripts/record.mjs <name> <chain> <L2 tx hash> [index]");
  process.exit(2);
}
const store = { l1: {}, l2: {} };
const clients = (c) => {
  const live = clientsFor(c);
  return { l1: recording(live.l1, store.l1), l2: recording(live.l2, store.l2) };
};
const r = await check(tx, { chain, index: Number(index), clients });
writeFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), JSON.stringify({ chain, tx, index: Number(index), recordedAt: new Date().toISOString(), store }, null, 1) + "\n");
console.log(renderText(r));
