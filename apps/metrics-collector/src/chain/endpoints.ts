// Owns how one scheduled chain read spends RPC calls: a primary endpoint (the free public devnet RPC)
// with a minimum interval between calls and a call budget, and an optional fallback (a paid RPC) used
// only after the primary rate-limits this run, with its own smaller budget. Calls are counted per
// endpoint for the run's log, so a slow or limited free endpoint is visible before paying for more.
import { ChainRpcError, type ChainRpc } from './rpc';

export interface EndpointLimits {
  // Calls this run may make on the endpoint.
  budget: number;
  // Minimum time between two calls on the endpoint.
  minIntervalMs: number;
}
export interface EndpointUse {
  calls: number;
  rateLimited: number;
}
export interface ChainEndpoints extends ChainRpc {
  // Calls left on the endpoint in use; the run stops reading when this reaches zero.
  remaining(): number;
  usage(): { primary: EndpointUse; fallback: EndpointUse; onFallback: boolean };
}
type Wait = (milliseconds: number) => Promise<void>;
const sleep: Wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function metered(
  rpc: ChainRpc,
  limits: EndpointLimits,
  wait: Wait,
  now: () => number,
) {
  const use: EndpointUse = { calls: 0, rateLimited: 0 };
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
      if (error instanceof ChainRpcError && error.rateLimited)
        use.rateLimited += 1;
      throw error;
    }
  }
  return { run, use, remaining: () => limits.budget - use.calls };
}

export function chainEndpoints(
  primary: { rpc: ChainRpc; limits: EndpointLimits },
  fallback: { rpc: ChainRpc; limits: EndpointLimits } | undefined,
  options: { wait?: Wait; now?: () => number } = {},
): ChainEndpoints {
  const wait = options.wait ?? sleep;
  const now = options.now ?? Date.now;
  const first = metered(primary.rpc, primary.limits, wait, now);
  const second = fallback
    ? metered(fallback.rpc, fallback.limits, wait, now)
    : undefined;
  let onFallback = false;
  async function call<T>(work: (rpc: ChainRpc) => Promise<T>): Promise<T> {
    if (!onFallback)
      try {
        return await first.run(work);
      } catch (error) {
        // Only a rate limit moves the run to the paid endpoint; any other failure stops it.
        if (!(error instanceof ChainRpcError && error.rateLimited) || !second)
          throw error;
        onFallback = true;
      }
    return second!.run(work);
  }
  return {
    signatures: (address, range) =>
      call((rpc) => rpc.signatures(address, range)),
    transaction: (signature) => call((rpc) => rpc.transaction(signature)),
    accounts: (addresses) => call((rpc) => rpc.accounts(addresses)),
    remaining: () => (onFallback ? second!.remaining() : first.remaining()),
    usage: () => ({
      primary: { ...first.use },
      fallback: { ...(second?.use ?? { calls: 0, rateLimited: 0 }) },
      onFallback,
    }),
  };
}
