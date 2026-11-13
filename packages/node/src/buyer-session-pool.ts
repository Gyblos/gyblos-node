// Bounded routing across independently persisted seller sessions; the private catalog owns all budget credit.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { recountSessionInput } from '@gyblos/core/session-input';
import type {
  BatchBuyerPool,
  BatchPoolEntry,
} from '@gyblos/payments-upto/batch-session';
import { verifyBatchQuote } from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import { controlInteger } from '@gyblos/protocol/control-validation';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';
import {
  BatchClientError,
  type BatchDestination,
} from '@gyblos/transport-iroh/batch-client';

import { bounded } from './buyer-operation';
import { createPoolAdmissions, type PoolLease } from './buyer-pool-admission';
import { UnsentSellerBusyError } from './buyer-routing';
import {
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
  admission: ReturnType<typeof createPoolAdmissions>;
  closing?: Promise<void>;
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
      transport: {
        ...state.options.transport,
        beforeExecute: (request) => {
          state.admission.beforeExecute(id);
          state.options.transport?.beforeExecute?.(request);
        },
      },
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
  const revision = state.admission.revision();
  if (await state.options.unresolved()) {
    state.admission.block(true);
    return true;
  }
  const entries = await state.options.inspect();
  if (entries.length === 0) return state.admission.block(false, revision);
  const pool = await catalog(state);
  let pending = false;
  const signal = AbortSignal.any([
    state.lifetime.signal,
    AbortSignal.timeout(BATCH_SESSION_DEFAULTS.operationMs),
  ]);
  for (const entry of await pool.list()) {
    signal.throwIfAborted();
    const owned = state.admission.leases.get(entry.terms.sellerNodeId);
    if (
      owned?.registered &&
      owned.running &&
      entry.requestId === owned.requestId
    )
      continue;
    if (owned?.registered && !owned.running) {
      pending = true;
      continue;
    }
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
  return state.admission.block(pending, revision);
}
async function execute<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2,
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  lease: PoolLease,
  onDelta?: (text: string) => Promise<void>,
) {
  recountSessionInput(quote, input, state.options.meter);
  await state.options.verify(quote, signal);
  const entry = await state.admission.serial(async () => {
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
    lease.registered = true;
    return entry;
  });
  const result = await manager(state, entry).execute(
    quote,
    input,
    signal,
    onDelta,
  );
  if (!(await (await catalog(state)).resolve(entry.terms.sellerNodeId)))
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
async function run<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2,
  input: FreeExecutionBuildInput,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
) {
  const id = quote.offer.nodeId;
  const lease = state.admission.enter(id, quote.offer.requestId);
  const current = AbortSignal.any([
    signal,
    state.lifetime.signal,
    lease.controller.signal,
  ]);
  return state.admission.track(
    Promise.resolve().then(async () => {
      try {
        return await execute(state, quote, input, current, lease, onDelta);
      } catch (error) {
        lease.running = false;
        if (lease.registered) {
          if (
            !lease.sent &&
            error instanceof BatchClientError &&
            error.remote &&
            (error.code === SESSION_CODES.BUSY ||
              error.code === PAID_EXECUTION_CODES.BUSY) &&
            (await state.admission.serial(async () =>
              (await catalog(state)).resolve(id, lease.requestId),
            ))
          )
            throw new UnsentSellerBusyError(id);
          state.admission.uncertain();
          await state.admission
            .serial(async () => {
              await (await catalog(state)).resolve(id);
            })
            .catch(() => undefined);
        }
        throw error;
      } finally {
        state.admission.leave(id, lease);
      }
    }),
  );
}
async function close<Remote extends BatchDestination>(state: State<Remote>) {
  state.lifetime.abort();
  await state.admission.drain();
  await Promise.allSettled(
    [...state.managers.values()].map((host) => host.close()),
  );
  await (await state.pool?.catch(() => undefined))?.dispose();
}
export function createBuyerSessionPool<Remote extends BatchDestination>(
  options: Options<Remote>,
) {
  const state: State<Remote> = {
    options,
    lifetime: new AbortController(),
    managers: new Map(),
    admission: createPoolAdmissions(),
    operationMs: controlInteger(
      options.operationMs ?? BATCH_SESSION_DEFAULTS.operationMs,
      1,
      BATCH_SESSION_DEFAULTS.operationMs,
    ),
  };
  return {
    busyNodeIds: () => new Set(state.admission.leases.keys()),
    checkBeforeExternalExecution: state.admission.check,
    unresolved: () => state.admission.serial(() => unresolved(state)),
    execute: (
      quote: SignedOfferV2,
      input: FreeExecutionBuildInput,
      signal: AbortSignal,
      onDelta?: (text: string) => Promise<void>,
    ) => run(state, quote, input, signal, onDelta),
    reconcile: (signal: AbortSignal) =>
      state.admission.maintain(() => summarize(state, signal, false)),
    settle: (signal: AbortSignal) =>
      state.admission.maintain(() => summarize(state, signal, true)),
    close: () => (state.closing ??= close(state)),
  };
}
