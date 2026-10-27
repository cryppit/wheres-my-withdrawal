#!/usr/bin/env node
// Usage: node cli.js <L2 tx hash> [--chain op|base|unichain|ink|soneium|worldchain|mode|zora|arb|robinhood|linea|zksync] [--index n] [--json]
//        node cli.js <OP Stack L2 tx hash> --prove [--chain op] [--from 0x…] [--json]   build and rehearse the prove call
import { check } from "./src/check.js";
import { renderText } from "./src/render.js";
import { CHAINS } from "./src/chains.js";
import { makeRpc } from "./src/rpc.js";
import { buildProve, buildBlastProve } from "./src/prove.js";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const tx = argv.find((a) => a.startsWith("0x"));
if (!tx) {
  console.error(`Usage: node cli.js <L2 tx hash> [--chain ${Object.keys(CHAINS).join("|")}] [--index n] [--json]`);
  process.exit(2);
}
if (argv.includes("--prove")) {
  // Read-only: builds proveWithdrawalTransaction from public data and rehearses it with eth_call. Nothing is sent.
  const chain = CHAINS[flag("chain") ?? "op"];
  if (!chain?.portal) {
    console.error(`--prove works on the OP Stack chains: ${Object.values(CHAINS).filter((c) => c.portal).map((c) => c.id).join(", ")}.`);
    process.exit(2);
  }
  const p = await (chain.stack === "blast" ? buildBlastProve : buildProve)(chain, tx, { l1: makeRpc(chain.l1Rpcs), l2: makeRpc(chain.l2Rpcs) }, { index: Number(flag("index") ?? 0), ...(flag("from") ? { from: flag("from") } : {}) });
  if (argv.includes("--json") || p.error) console.log(JSON.stringify(p, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  else {
    console.log(`Withdrawal ${p.withdrawal.hash} (L2 block ${p.withdrawal.l2Block})`);
    if (p.output) console.log(`Output #${p.output.index} on the L2OutputOracle (${p.output.oracle}), L2 block ${p.output.l2BlockNumber}`);
    else console.log(`Dispute game #${p.game.index} (${p.game.proxy}), type ${p.game.type}, ${p.game.status}, L2 block ${p.game.l2BlockNumber}`);
    const what = p.output ? "the oracle's output" : "the game's claim";
    console.log(`Output root ${p.outputRoot}: ${p.checks.outputRootMatchesGame ? `matches ${what}` : `DOES NOT match ${what}`}`);
    console.log(`Withdrawal stored on L2: ${p.checks.withdrawalStoredOnL2 ? "yes" : "NO"}`);
    console.log(`Rehearsal (eth_call from ${p.rehearsal.from}): ${p.rehearsal.ok ? `passes, about ${p.rehearsal.gas} gas` : `reverts: ${p.rehearsal.error}`}`);
    console.log(`\nSend to ${p.call.to}, value 0, data:\n${p.call.data}`);
  }
  process.exit(p.error || !p.rehearsal?.ok ? 1 : 0);
}
const r = await check(tx, { chain: flag("chain") ?? "auto", index: Number(flag("index") ?? 0) });
if (argv.includes("--json")) {
  console.log(JSON.stringify(r, (k, v) => (typeof v === "bigint" ? v.toString() : k === "chain" && v?.id ? v.id : v), 2));
} else console.log(renderText(r));
process.exit(r.error ? 1 : 0);
