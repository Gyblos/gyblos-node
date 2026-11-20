// Owns how one scheduled chain read spends RPC calls: a primary endpoint (the free public devnet RPC)
// with a minimum interval between calls and a call budget, then keyed fallbacks in order (for example
// Helius, then Alchemy), each with its own smaller budget. The run moves to the next endpoint only when
// the current one fails it: a refusal (a rate limit, or a 403 such as the public RPC answers Cloudflare
// Workers), an endpoint of another network, a server error, or a transport failure (a timeout or a
// dropped connection). An answer the index cannot read stops the run instead. Calls are counted per
// endpoint for the run's log, so a slow or refused free endpoint is visible before relying on keyed ones.
import { ChainShapeError } from './json';
import { ChainRpcError, type ChainRpc } from './rpc';

export interface EndpointLimits {
  // Calls this run may make on the endpoint.
  budget: number;
  // Minimum time between two calls on the endpoint.
  minIntervalMs: number;
}
export interface EndpointUse {
  calls: number;
  // Calls the endpoint refused or failed (the run then moved on), wrong networks apart.
  rateLimited: number;
  // Calls refused because the endpoint serves another network (the run then moved on).
  wrongNetwork: number;
}
export interface ChainEndpoints extends ChainRpc {
  // Calls left on the endpoint in use; the run stops reading when this reaches zero.
  remaining(): number;
  usage(): {
    primary: EndpointUse;
    // All fallbacks together.
    fallback: EndpointUse;
    onFallback: boolean;
    // Endpoint in use: 0 the public one, 1 the first fallback, and so on.
    endpoint: number;
  };
}
type Wait = (milliseconds: number) => Promise<void>;
const sleep: Wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const SERVER_ERROR = /^HTTP 5\d\d$/;

// The endpoint failed this run, so the next one may serve it: a refusal, a server error, or a failure
// to get any answer. A spent budget, a lagging answer or an unreadable one do not move the run.
function endpointFailed(error: unknown) {
  if (error instanceof ChainShapeError) return false;
  if (error instanceof ChainRpcError)
    return (
      error.rateLimited || error.wrongNetwork || SERVER_ERROR.test(error.reason)
    );
  return true;
}

function metered(
  rpc: ChainRpc,
  limits: EndpointLimits,
  wait: Wait,
  now: () => number,
) {
  const use: EndpointUse = { calls: 0, rateLimited: 0, wrongNetwork: 0 };
  let last = Number.NEGATIVE_INFINITY;
  async function run<T>(call: (rpc: ChainRpc) => Promise<T>): Promise<T> {
    if (use.calls >= limits.budget)
      throw new ChainRpcError('call budget spent');
    const pause = limits.minIntervalMs - (now() - last);
    if (pause > 0) await wait(pause);
    last = now();
    use.calls += 1;
    try {
      return await call(rpc);
    } catch (error) {
      if (error instanceof ChainRpcError && error.wrongNetwork)
        use.wrongNetwork += 1;
      else if (endpointFailed(error)) use.rateLimited += 1;
      throw error;
    }
  }
  return { run, use, remaining: () => limits.budget - use.calls };
}

type Endpoint = { rpc: ChainRpc; limits: EndpointLimits };

export function chainEndpoints(
  primary: Endpoint,
  fallbacks: readonly Endpoint[] | Endpoint | undefined,
  options: { wait?: Wait; now?: () => number } = {},
): ChainEndpoints {
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const later = fallbacks === undefined ? [] : [fallbacks].flat();
  const endpoints = [primary, ...later].map((entry) =>
    metered(entry.rpc, entry.limits, wait, now),
  );
  let current = 0;
  async function call<T>(work: (rpc: ChainRpc) => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await endpoints[current]!.run(work);
      } catch (error) {
        if (!endpointFailed(error) || current >= endpoints.length - 1)
          throw error;
        current += 1;
      }
    }
  }
  const sum = (uses: EndpointUse[]) =>
    uses.reduce(
      (total, use) => ({
        calls: total.calls + use.calls,
        rateLimited: total.rateLimited + use.rateLimited,
        wrongNetwork: total.wrongNetwork + use.wrongNetwork,
      }),
      { calls: 0, rateLimited: 0, wrongNetwork: 0 },
    );
  return {
    signatures: (address, range) =>
      call((rpc) => rpc.signatures(address, range)),
    transaction: (signature) => call((rpc) => rpc.transaction(signature)),
    accounts: (addresses) => call((rpc) => rpc.accounts(addresses)),
    remaining: () => endpoints[current]!.remaining(),
    usage: () => ({
      primary: { ...endpoints[0]!.use },
      fallback: sum(endpoints.slice(1).map((endpoint) => endpoint.use)),
      onFallback: current > 0,
      endpoint: current,
    }),
  };
}
