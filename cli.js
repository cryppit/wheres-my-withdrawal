#!/usr/bin/env node
// Usage: node cli.js <L2 tx hash> [--chain op|base] [--index n] [--json]
import { check } from "./src/check.js";
import { renderText } from "./src/render.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const tx = argv.find((a) => a.startsWith("0x"));
if (!tx) {
  console.error("Usage: node cli.js <L2 tx hash> [--chain op|base] [--index n] [--json]");
  process.exit(2);
}
const r = await check(tx, { chain: flag("chain") ?? "auto", index: Number(flag("index") ?? 0) });
if (argv.includes("--json")) {
  console.log(JSON.stringify(r, (k, v) => (typeof v === "bigint" ? v.toString() : k === "chain" && v?.id ? v.id : v), 2));
} else console.log(renderText(r));
process.exit(r.error ? 1 : 0);
