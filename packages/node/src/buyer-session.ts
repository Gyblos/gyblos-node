// One explicitly authorized reusable session for shared buyer hosts; no selection or prompt retry.
import { PROTOCOL_FEE } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { recountSessionInput } from '@gyblos/core/session-input';
import type { BatchStoredSession } from '@gyblos/payments-upto/batch-session';
import { verifyBatchQuote } from '@gyblos/protocol/batch-channel';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  sessionFail,
  type PaymentSessionTerms,
  type SessionBuyer,
} from '@gyblos/protocol/payment-session';
import type {
  BatchClientOptions,
  BatchDestination,
  BatchEndpoint,
} from '@gyblos/transport-iroh/batch-client';

import { createBuyerBatchSession } from './batch-buyer';
import { bounded } from './buyer-operation';
import { sessionApproval } from './session-accounting';
import type { BuyerSessionBackend } from './session-backend';
import {
  parseBuyerSessionPolicy,
  sessionTerms,
  type BuyerSessionPolicy,
} from './session-policy';

export interface BuyerSessionOptions<Remote extends BatchDestination> {
  policy: BuyerSessionPolicy;
  inspect(): Promise<BatchStoredSession | undefined>;
  backend(): Promise<BuyerSessionBackend>;
  endpoint: BatchEndpoint<Remote>;
  destination(terms: PaymentSessionTerms): Remote;
  meter: ChatTokenizer;
  now: () => number;
  unresolved(): Promise<boolean>;
  verify(quote: SignedOfferV2, signal: AbortSignal): Promise<void>;
  transport?: BatchClientOptions;
}
interface Current<Remote extends BatchDestination> {
  terms: PaymentSessionTerms;
  financial: SessionBuyer;
  host: ReturnType<typeof createBuyerBatchSession<Remote>>;
}
interface State<Remote extends BatchDestination> {
  options: BuyerSessionOptions<Remote>;
  lifetime: AbortController;
  backend?: Promise<BuyerSessionBackend>;
  current?: Promise<Current<Remote>>;
  active: boolean;
}
async function openCurrent<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2 | undefined,
  signal: AbortSignal,
): Promise<Current<Remote>> {
  const options = state.options;
  const stored = await bounded(options.inspect(), signal);
  const terms =
    stored?.terms ??
    (quote ? sessionTerms(quote, options.policy, options.now()) : undefined);
  if (!terms) return sessionFail(SESSION_CODES.UNAVAILABLE);
  if (quote)
    await verifyBatchQuote(
      quote,
      terms,
      options.endpoint.id().toString(),
      options.now(),
    );
  signal.throwIfAborted();
  const destination = options.destination(terms);
  if (!state.backend) {
    const pending = options.backend();
    state.backend = pending;
    void pending.catch(() => {
      if (state.backend === pending) state.backend = undefined;
    });
  }
  const backend = await bounded(state.backend, signal);
  signal.throwIfAborted();
  const financial = await backend.create(terms);
  try {
    if (signal.aborted || state.lifetime.signal.aborted)
      return sessionFail(SESSION_CODES.UNAVAILABLE);
    return {
      terms,
      financial,
      host: createBuyerBatchSession({
        ...options,
        terms,
        buyer: financial,
        destination,
        observe: backend.observe,
      }),
    };
  } catch (error) {
    await financial.dispose();
    throw error;
  }
}
function current<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2 | undefined,
  signal: AbortSignal,
) {
  if (!state.current) {
    const pending = openCurrent(state, quote, signal);
    state.current = pending;
    void pending.catch(() => {
      if (state.current === pending) state.current = undefined;
    });
  }
  return bounded(state.current, signal);
}
async function run<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2,
  input: FreeExecutionBuildInput,
  external: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
) {
  const signal = AbortSignal.any([external, state.lifetime.signal]);
  recountSessionInput(quote, input, state.options.meter);
  await bounded(state.options.verify(quote, signal), signal);
  if (await bounded(state.options.unresolved(), signal))
    return sessionFail(SESSION_CODES.UNVERIFIED);
  const opened = await current(state, quote, signal);
  if (
    BigInt(opened.terms.depositAtomic) >
      BigInt(state.options.policy.depositAtomic) ||
    opened.terms.withdrawDelaySeconds >
      state.options.policy.withdrawDelaySeconds ||
    opened.terms.protocolFeeBps !== PROTOCOL_FEE.bps ||
    opened.terms.treasury !== PROTOCOL_FEE.treasury ||
    opened.terms.expiresAt - state.options.now() >
      state.options.policy.lifetimeMs
  )
    return sessionFail(SESSION_CODES.LIMIT);
  const before = opened.financial.snapshot();
  const value = await opened.host.execute(quote, input, signal, onDelta);
  const after = opened.financial.snapshot();
  return {
    value,
    approval: sessionApproval({
      approvedAtomic: String(
        BigInt(after.cumulativeAtomic) - BigInt(before.cumulativeAtomic),
      ),
      cumulativeAtomic: after.cumulativeAtomic,
      depositAtomic: opened.terms.depositAtomic,
    }),
  };
}
async function unresolved<Remote extends BatchDestination>(
  state: State<Remote>,
) {
  if (await state.options.unresolved()) return true;
  let stored = await state.options.inspect();
  if (stored?.pending && stored.recoverable) {
    const signal = AbortSignal.any([
      state.lifetime.signal,
      AbortSignal.timeout(BATCH_SESSION_DEFAULTS.operationMs),
    ]);
    try {
      await (
        await current(state, undefined, signal)
      ).host.recoverApproval(signal);
    } catch {
      // A disconnected seller may already have settled; only independent proof can clear uncertainty.
    }
    stored = await state.options.inspect();
  }
  if (stored?.pending) {
    const signal = AbortSignal.any([
      state.lifetime.signal,
      AbortSignal.timeout(BATCH_SESSION_DEFAULTS.operationMs),
    ]);
    await (await current(state, undefined, signal)).host.reconcile(signal);
    stored = await state.options.inspect();
  }
  return stored?.pending ?? false;
}
export function createBuyerSessionManager<Remote extends BatchDestination>(
  input: BuyerSessionOptions<Remote>,
) {
  const options = { ...input, policy: parseBuyerSessionPolicy(input.policy) };
  const state: State<Remote> = {
    options,
    lifetime: new AbortController(),
    active: false,
  };
  return {
    unresolved: () => unresolved(state),
    async execute(
      quote: SignedOfferV2,
      data: FreeExecutionBuildInput,
      signal: AbortSignal,
      onDelta?: (text: string) => Promise<void>,
    ) {
      if (state.active) return sessionFail(SESSION_CODES.BUSY);
      state.active = true;
      try {
        return await run(state, quote, data, signal, onDelta);
      } finally {
        state.active = false;
      }
    },
    async reconcile(signal: AbortSignal) {
      if (!(await options.inspect())) return undefined;
      return (await current(state, undefined, signal)).host.reconcile(signal);
    },
    async settle(signal: AbortSignal) {
      if (!(await options.inspect())) return undefined;
      const opened = await current(state, undefined, signal);
      return (await opened.host.reconcile(signal)) ?? opened.host.close(signal);
    },
    async close() {
      state.lifetime.abort();
      const opened = await state.current?.catch(() => undefined);
      if (opened) {
        await opened.host.disconnect();
        await opened.host.settled();
        await opened.financial.dispose();
      }
    },
  };
}
