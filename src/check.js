// One entry point for the CLI, the page and the tests: find the chain, read the facts, give the verdict.
import { CHAINS } from "./chains.js";
import { makeRpc } from "./rpc.js";
import { readFacts as readOpStack } from "./opstack.js";
import { readFacts as readArbitrum, claimOf as claimOfArbitrum } from "./arbitrum.js";
import { readFacts as readLinea } from "./linea.js";
import { readFacts as readZksync, claimOf as claimOfZksync } from "./zksync.js";
import { verdict } from "./verdict.js";

export function clientsFor(chain, opts = {}) {
  const clients = { l1: makeRpc(chain.l1Rpcs, opts), l2: makeRpc(chain.l2Rpcs, opts) };
  if (chain.l1ArchiveRpcs) clients.l1Archive = makeRpc(chain.l1ArchiveRpcs, opts);
  return clients;
}

const READERS = { op: readOpStack, arbitrum: readArbitrum, linea: readLinea, zksync: readZksync };
// The slow "who sent the last step" searches, run after the verdict when the page asks for deferExtras.
const CLAIMERS = { arbitrum: claimOfArbitrum, zksync: claimOfZksync };

/**
 * Check one withdrawal. `chain` is a key of CHAINS ("op", "base", "arb", "linea", "zksync") or "auto" (ask every
 * chain's L2 for the transaction at once).
 * `clients(chain)` returns the { l1, l2, l1Archive? } RPC functions; tests pass recorded ones.
 *
 * With `deferExtras`, the answer comes back as soon as the verdict is known, and slow extras (who sent an Arbitrum
 * claim or a ZKsync finalize, which need a search through Ethereum history) arrive later: `extras` is then a promise of the full result.
 * Without it (the CLI), everything is read first and there is no `extras`.
 */
export async function check(txHash, { chain = "auto", index = 0, clients = (c) => clientsFor(c), deferExtras = false } = {}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { error: "bad-hash", message: "A transaction hash is 0x followed by 64 hex characters." };
  const candidates = chain === "auto" ? Object.values(CHAINS) : [CHAINS[chain]].filter(Boolean);
  if (!candidates.length) return { error: "bad-chain", message: `Unknown chain "${chain}". Use: ${Object.keys(CHAINS).join(", ")}.` };

  const attempt = async (c) => {
    const cl = clients(c);
    const facts = await READERS[c.stack](c, txHash, cl, { index, deferClaim: deferExtras });
    if (facts.error) return { chain: c, ...facts };
    const r = { chain: c, facts, verdict: verdict(facts) };
    if (facts.claimLookup === "pending") {
      r.extras = CLAIMERS[c.stack](facts, cl, c).then((found) => {
        const full = { ...facts, ...found };
        return { chain: c, facts: full, verdict: verdict(full) };
      });
    }
    return r;
  };

  const r = await firstFound(candidates.map(attempt));
  if (r) return r;
  return { error: "not-found", message: `No ${candidates.map((c) => c.name).join(" or ")} transaction with this hash.` };
}

/**
 * The first attempt that found the transaction, without waiting for slower chains (a transaction hash exists on one
 * chain only). null if every chain said "not found". If none found it and one failed, that failure is thrown: the
 * transaction may be on the chain whose RPCs did not answer.
 */
function firstFound(attempts) {
  return new Promise((resolve, reject) => {
    let left = attempts.length;
    let failure = null;
    const settle = () => {
      if (--left > 0) return;
      if (failure) reject(failure);
      else resolve(null);
    };
    for (const a of attempts) {
      a.then(
        (r) => (r.error === "not-found" ? settle() : resolve(r)),
        (e) => {
          failure ??= e;
          settle();
        },
      );
    }
  });
}
