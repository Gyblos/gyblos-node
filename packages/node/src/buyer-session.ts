// One explicitly authorized reusable session for shared buyer hosts; no selection or prompt retry.
import { PROTOCOL_FEE } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import type { BatchStoredSession } from '@gyblos/payments-upto/batch-session';
import {
  batchExecutionInput,
  batchFail,
  verifyBatchQuote,
} from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  FREE_CHAT_ROLES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
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
  meter: RecountTokenizer;
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
  if (
    BigInt(terms.depositAtomic) > BigInt(options.policy.depositAtomic) ||
    terms.withdrawDelaySeconds > options.policy.withdrawDelaySeconds
  )
    return sessionFail(SESSION_CODES.LIMIT);
  if (quote)
    await verifyBatchQuote(
      quote,
      terms,
      options.endpoint.id().toString(),
      options.now(),
    );
  signal.throwIfAborted();
  state.backend ??= options.backend();
  const backend = await bounded(state.backend, signal);
  signal.throwIfAborted();
  const financial = await backend.create(terms);
  if (signal.aborted || state.lifetime.signal.aborted) {
    await financial.dispose();
    return sessionFail(SESSION_CODES.UNAVAILABLE);
  }
  return {
    terms,
    financial,
    host: createBuyerBatchSession({
      ...options,
      terms,
      buyer: financial,
      destination: options.destination(terms),
      observe: backend.observe,
    }),
  };
}
function current<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2 | undefined,
  signal: AbortSignal,
) {
  state.current ??= openCurrent(state, quote, signal);
  return bounded(state.current, signal);
}
async function run<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2,
  input: FreeExecutionBuildInput,
  external: AbortSignal,
) {
  const signal = AbortSignal.any([external, state.lifetime.signal]);
  const checked = batchExecutionInput(quote, input);
  if (
    checked.messages.length !== 1 ||
    checked.messages[0]?.role !== FREE_CHAT_ROLES.USER ||
    quote.offer.reasoning !== REASONING_LEVELS.OFF ||
    quote.offer.meteringMode !== CONTROL_METERING_MODES.RECOUNTED
  )
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
  await bounded(state.options.verify(quote, signal), signal);
  if (await bounded(state.options.unresolved(), signal))
    return sessionFail(SESSION_CODES.UNVERIFIED);
  const opened = await current(state, quote, signal);
  if (
    opened.terms.protocolFeeBps !== PROTOCOL_FEE.bps ||
    opened.terms.treasury !== PROTOCOL_FEE.treasury ||
    opened.terms.expiresAt - state.options.now() >
      state.options.policy.lifetimeMs
  )
    return sessionFail(SESSION_CODES.LIMIT);
  const before = opened.financial.snapshot();
  const value = await opened.host.execute(quote, input, signal);
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
    await (
      await current(state, undefined, signal)
    ).host.recoverApproval(signal);
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
    ) {
      if (state.active) return sessionFail(SESSION_CODES.BUSY);
      state.active = true;
      try {
        return await run(state, quote, data, signal);
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
