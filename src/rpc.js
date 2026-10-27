// A JSON-RPC client over plain fetch that tries each public endpoint in turn. It works the same in a browser and in
// Node. `recording` and `replaying` wrap a client so the tests run on real responses without the network.

export class RpcError extends Error {}

const isRevert = (err) => err && (err.code === 3 || /revert/i.test(err.message ?? ""));

// A free endpoint that answers 429 (too many requests) is asked again after these pauses before the next one is tried.
const BUSY_PAUSES_MS = [1000, 2000];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeRpc(urls, { fetch: doFetch = globalThis.fetch, timeoutMs = 20_000, sleep = pause } = {}) {
  let id = 0;
  return async function call(method, params) {
    const problems = [];
    for (const url of urls) {
      try {
        const post = () =>
          doFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        let res = await post();
        for (const ms of BUSY_PAUSES_MS) {
          if (res.status !== 429) break;
          await sleep(ms);
          res = await post();
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        // A revert is an answer, not an outage: the next endpoint would say the same.
        if (body.error && method === "eth_call" && isRevert(body.error)) return { reverted: true };
        if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
        return body.result;
      } catch (e) {
        problems.push(`${new URL(url).host}: ${e.message}`);
      }
    }
    throw new RpcError(`${method} failed on every endpoint (${problems.join("; ")})`);
  };
}

/** Calls f on each item, a few at a time: the free archive endpoints answer 429 to fifteen history calls at once. */
export async function inBatches(items, f, size = 4) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(f))));
  return out;
}

const key = (method, params) => `${method} ${JSON.stringify(params)}`;

export function recording(call, store) {
  return async (method, params) => {
    const result = await call(method, params);
    store[key(method, params)] = result;
    return result;
  };
}

export function replaying(store) {
  return async (method, params) => {
    const k = key(method, params);
    if (!(k in store)) throw new RpcError(`not in fixture: ${k}`);
    return store[k];
  };
}
