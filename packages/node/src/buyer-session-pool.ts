// Sequential routing across independently persisted seller sessions; the private catalog owns all budget credit.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import type {
  BatchBuyerPool,
  BatchPoolEntry,
} from '@gyblos/payments-upto/batch-session';
import { verifyBatchQuote } from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { controlInteger } from '@gyblos/protocol/control-validation';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';
import type { BatchDestination } from '@gyblos/transport-iroh/batch-client';

import { bounded } from './buyer-operation';
import {
  checkBuyerSessionInput,
  createBuyerSessionManager,
  type BuyerSessionOptions,
} from './buyer-session';
import { sessionTerms } from './session-policy';

type Options<Remote extends BatchDestination> = Omit<
  BuyerSessionOptions<Remote>,
  'inspect' | 'backend'
> & {
  inspect(): Promise<BatchPoolEntry[]>;
  pool(): Promise<BatchBuyerPool>;
  operationMs?: number;
};
interface State<Remote extends BatchDestination> {
  options: Options<Remote>;
  lifetime: AbortController;
  pool?: Promise<BatchBuyerPool>;
  managers: Map<string, ReturnType<typeof createBuyerSessionManager<Remote>>>;
  active: boolean;
  pending?: Promise<unknown>;
  operationMs: number;
}
function catalog<Remote extends BatchDestination>(state: State<Remote>) {
  if (!state.pool) {
    const current = state.options.pool();
    state.pool = current;
    void current.catch(() => {
      if (state.pool === current) state.pool = undefined;
    });
  }
  return state.pool;
}
function manager<Remote extends BatchDestination>(
  state: State<Remote>,
  entry: BatchPoolEntry,
) {
  const id = entry.terms.sellerNodeId;
  let found = state.managers.get(id);
  if (!found) {
    found = createBuyerSessionManager({
      ...state.options,
      inspect: async () =>
        (await (await catalog(state)).list()).find(
          (entry) => entry.terms.sellerNodeId === id,
        )?.stored,
      backend: async () => (await catalog(state)).backend(id),
    });
    state.managers.set(id, found);
  }
  return found;
}
async function unresolved<Remote extends BatchDestination>(
  state: State<Remote>,
) {
  if (await state.options.unresolved()) return true;
  const entries = await state.options.inspect();
  if (entries.length === 0) return false;
  const pool = await catalog(state);
  let pending = false;
  const signal = AbortSignal.any([
    state.lifetime.signal,
    AbortSignal.timeout(BATCH_SESSION_DEFAULTS.operationMs),
  ]);
  for (const entry of await pool.list()) {
    signal.throwIfAborted();
    if (entry.stored?.snapshot.state === SESSION_STATES.CLOSED) {
      await pool.resolve(entry.terms.sellerNodeId);
      continue;
    }
    if (entry.uncertain || entry.requestId !== null || entry.stored?.pending) {
      try {
        await bounded(manager(state, entry).unresolved(), signal);
      } catch {
        /* Original intent remains; only financial recovery or finality can clear it. */
      }
      if (!(await pool.resolve(entry.terms.sellerNodeId))) pending = true;
      if (
        (await pool.list()).find(
          (candidate) =>
            candidate.terms.sellerNodeId === entry.terms.sellerNodeId,
        )?.stored?.pending
      )
        pending = true;
    }
  }
  return pending;
}
async function execute<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2,
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
) {
  checkBuyerSessionInput(quote, input);
  await state.options.verify(quote, signal);
  if (await unresolved(state)) return sessionFail(SESSION_CODES.UNVERIFIED);
  signal.throwIfAborted();
  const pool = await catalog(state);
  const existing = (await pool.list()).find(
    (entry) => entry.terms.sellerNodeId === quote.offer.nodeId,
  );
  const terms =
    existing?.terms ??
    sessionTerms(quote, state.options.policy, state.options.now());
  await verifyBatchQuote(
    quote,
    terms,
    state.options.endpoint.id().toString(),
    state.options.now(),
  );
  if (
    existing?.stored?.snapshot.state === SESSION_STATES.CLOSED ||
    state.options.now() >= terms.expiresAt
  )
    return sessionFail(SESSION_CODES.CLOSED);
  const budget = await pool.budget();
  if (
    BigInt(budget.committedAtomic) >
    BigInt(
      state.options.policy.totalDepositAtomic ??
        state.options.policy.depositAtomic,
    )
  )
    return sessionFail(SESSION_CODES.LIMIT);
  const entry = await pool.allocate(terms);
  signal.throwIfAborted();
  await pool.begin(terms.sellerNodeId, quote.offer.requestId);
  const result = await manager(state, entry).execute(quote, input, signal);
  if (!(await pool.resolve(terms.sellerNodeId)))
    return sessionFail(SESSION_CODES.UNVERIFIED);
  return result;
}
async function summarize<Remote extends BatchDestination>(
  state: State<Remote>,
  signal: AbortSignal,
  close: boolean,
) {
  if ((await state.options.inspect()).length === 0) return undefined;
  const pool = await catalog(state);
  let charged = 0n;
  let refunded = 0n;
  let complete = true;
  const entries = await pool.list();
  const overall = AbortSignal.any([
    signal,
    state.lifetime.signal,
    AbortSignal.timeout(state.operationMs),
  ]);
  const sliceMs = Math.max(
    1,
    Math.floor(state.operationMs / Math.max(1, entries.length)),
  );
  for (const entry of entries) {
    try {
      overall.throwIfAborted();
      const host = manager(state, entry);
      const peer = AbortSignal.any([overall, AbortSignal.timeout(sliceMs)]);
      const result = await bounded(
        close ? host.settle(peer) : host.reconcile(peer),
        peer,
      );
      if (!result) {
        complete = false;
        continue;
      }
      await pool.resolve(entry.terms.sellerNodeId);
      charged += BigInt(result.chargedAtomic);
      refunded += BigInt(result.refundedAtomic);
    } catch {
      complete = false;
    }
  }
  return complete
    ? { chargedAtomic: String(charged), refundedAtomic: String(refunded) }
    : undefined;
}
export function createBuyerSessionPool<Remote extends BatchDestination>(
  options: Options<Remote>,
) {
  const state: State<Remote> = {
    options,
    lifetime: new AbortController(),
    managers: new Map(),
    active: false,
    operationMs: controlInteger(
      options.operationMs ?? BATCH_SESSION_DEFAULTS.operationMs,
      1,
      BATCH_SESSION_DEFAULTS.operationMs,
    ),
  };
  const exclusive = async <T>(run: () => Promise<T>) => {
    if (state.active) return sessionFail(SESSION_CODES.BUSY);
    state.active = true;
    const current = Promise.resolve().then(() => {
      state.lifetime.signal.throwIfAborted();
      return run();
    });
    state.pending = current;
    try {
      return await current;
    } finally {
      state.active = false;
    }
  };
  return {
    unresolved: () => exclusive(() => unresolved(state)),
    execute: (
      quote: SignedOfferV2,
      input: FreeExecutionBuildInput,
      signal: AbortSignal,
    ) =>
      exclusive(() =>
        execute(
          state,
          quote,
          input,
          AbortSignal.any([signal, state.lifetime.signal]),
        ),
      ),
    reconcile: (signal: AbortSignal) =>
      exclusive(() => summarize(state, signal, false)),
    settle: (signal: AbortSignal) =>
      exclusive(() => summarize(state, signal, true)),
    async close() {
      state.lifetime.abort();
      await state.pending?.catch(() => undefined);
      await Promise.allSettled(
        [...state.managers.values()].map((host) => host.close()),
      );
      await (await state.pool?.catch(() => undefined))?.dispose();
    },
  };
}
