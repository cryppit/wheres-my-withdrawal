// One entry point for the CLI, the page and the tests: find the chain, read the facts, give the verdict.
import { CHAINS } from "./chains.js";
import { makeRpc } from "./rpc.js";
import { readFacts as readOpStack } from "./opstack.js";
import { readFacts as readArbitrum } from "./arbitrum.js";
import { readFacts as readLinea } from "./linea.js";
import { readFacts as readZksync } from "./zksync.js";
import { verdict } from "./verdict.js";

export function clientsFor(chain, opts = {}) {
  return { l1: makeRpc(chain.l1Rpcs, opts), l2: makeRpc(chain.l2Rpcs, opts) };
}

const READERS = { op: readOpStack, arbitrum: readArbitrum, linea: readLinea, zksync: readZksync };

/**
 * Check one withdrawal. `chain` is a key of CHAINS ("op", "base", "arb", "linea", "zksync") or "auto" (try each chain's L2 for
 * the transaction).
 * `clients(chain)` returns the { l1, l2 } RPC functions; tests pass recorded ones.
 */
export async function check(txHash, { chain = "auto", index = 0, clients = (c) => clientsFor(c) } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { error: "bad-hash", message: "A transaction hash is 0x followed by 64 hex characters." };
  const candidates = chain === "auto" ? Object.values(CHAINS) : [CHAINS[chain]].filter(Boolean);
  if (!candidates.length) return { error: "bad-chain", message: `Unknown chain "${chain}". Use: ${Object.keys(CHAINS).join(", ")}.` };
  let last = null;
  for (const c of candidates) {
    const read = READERS[c.stack];
    const facts = await read(c, txHash, clients(c), { index });
    if (facts.error === "not-found") {
      last = facts;
      continue;
    }
    if (facts.error) return { chain: c, ...facts };
    return { chain: c, facts, verdict: verdict(facts) };
  }
  return chain === "auto" ? { error: "not-found", message: `No ${candidates.map((c) => c.name).join(" or ")} transaction with this hash.` } : last;
}
