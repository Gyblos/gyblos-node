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
  SESSION_STATES,
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
import type { BuyerBatchSessionOptions } from './batch-buyer-types';
import {
  prepareNewChannel,
  type PreparedChannel,
} from './buyer-channel-prepare';
import { UnsentOpeningError } from './buyer-opening-retry';
import { checkPreviousOpening, disposeAbsent } from './buyer-opening-state';
import { bounded } from './buyer-operation';
import { UnsentSellerBusyError } from './buyer-routing';
import { sessionApproval } from './session-accounting';
import type { BuyerSessionBackend } from './session-backend';
import {
  newSessionTerms,
  parseBuyerSessionPolicy,
  type BuyerSessionPolicy,
} from './session-policy';

export interface BuyerSessionOptions<Remote extends BatchDestination> {
  // Known capability of the financial adapter. Unspecified adapters negotiate after construction.
  onDeclined?: BuyerBatchSessionOptions<Remote>['onDeclined'];
  beforeInference?: BuyerBatchSessionOptions<Remote>['beforeInference'];
  switchingAllowed?(): boolean;
  openingSupportsBlocks?: boolean;
  preparation?: PreparedChannel;
  receipt?: BuyerBatchSessionOptions<Remote>['receipt'];
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
export interface Current<Remote extends BatchDestination> {
  terms: PaymentSessionTerms;
  priorSpentAtomic: string;
  financial: SessionBuyer;
  host: ReturnType<typeof createBuyerBatchSession<Remote>>;
}
export interface State<Remote extends BatchDestination> {
  options: BuyerSessionOptions<Remote>;
  lifetime: AbortController;
  backend?: Promise<BuyerSessionBackend>;
  current?: Promise<Current<Remote>>;
  active: boolean;
}
function getBackend<Remote extends BatchDestination>(
  state: State<Remote>,
  signal: AbortSignal,
) {
  if (!state.backend) {
    const pending = state.options.backend();
    state.backend = pending;
    void pending.catch(() => {
      if (state.backend === pending) state.backend = undefined;
    });
  }
  return bounded(state.backend, signal);
}
async function openCurrent<Remote extends BatchDestination>(
  state: State<Remote>,
  quote: SignedOfferV2 | undefined,
  signal: AbortSignal,
): Promise<Current<Remote>> {
  const options = state.options;
  const stored = await bounded(options.inspect(), signal);
  if (stored?.notCreated || stored?.openingReturned) {
    if (!quote) return sessionFail(SESSION_CODES.CLOSED);
    const backend = await getBackend(state, signal);
    if (!backend.renew) return sessionFail(SESSION_CODES.CLOSED);
    const replacement = newSessionTerms(
      quote,
      {
        ...options.policy,
        depositAtomic: String(
          BigInt(options.policy.depositAtomic) -
            BigInt(stored.priorSpentAtomic ?? '0'),
        ),
      },
      options.now(),
    );
    await verifyBatchQuote(
      quote,
      replacement,
      options.endpoint.id().toString(),
      options.now(),
    );
    signal.throwIfAborted();
    await backend.renew(
      stored.snapshot.channelId,
      replacement,
      options.policy.depositAtomic,
    );
    const renewed = await options.inspect();
    if (!renewed || renewed.notCreated || renewed.openingReturned)
      return sessionFail(SESSION_CODES.UNVERIFIED);
    return openCurrent(state, quote, signal);
  }
  const terms =
    stored?.terms ??
    (quote ? newSessionTerms(quote, options.policy, options.now()) : undefined);
  if (!terms) return sessionFail(SESSION_CODES.UNAVAILABLE);
  if (quote && !stored)
    await verifyBatchQuote(
      quote,
      terms,
      options.endpoint.id().toString(),
      options.now(),
    );
  const preparation =
    quote && !stored && options.openingSupportsBlocks !== undefined
      ? await prepareNewChannel(options, quote, terms, signal)
      : options.preparation;
  signal.throwIfAborted();
  const destination = options.destination(terms);
  const backend = await getBackend(state, signal);
  signal.throwIfAborted();
  const financial = await backend.create(terms);
  try {
    if (signal.aborted || state.lifetime.signal.aborted)
      return sessionFail(SESSION_CODES.UNAVAILABLE);
    return {
      terms,
      priorSpentAtomic: stored?.priorSpentAtomic ?? '0',
      financial,
      host: createBuyerBatchSession({
        ...options,
        preparation,
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
    BigInt(opened.priorSpentAtomic) + BigInt(opened.terms.depositAtomic) >
      BigInt(state.options.policy.depositAtomic) ||
    opened.terms.withdrawDelaySeconds >
      state.options.policy.withdrawDelaySeconds ||
    opened.terms.protocolFeeBps !== PROTOCOL_FEE.bps ||
    opened.terms.treasury !== PROTOCOL_FEE.treasury ||
    opened.terms.expiresAt - state.options.now() >
      state.options.policy.lifetimeMs
  )
    return sessionFail(SESSION_CODES.LIMIT);
  const switching =
    opened.terms.sellerNodeId !== quote.offer.nodeId ||
    opened.terms.owner !== quote.offer.owner;
  if (switching && !state.options.switchingAllowed?.())
    throw new UnsentSellerBusyError(quote.offer.nodeId);
  const ready = await renewable(state, opened, quote, signal, switching);
  const before = ready.financial.snapshot();
  const value = await ready.host
    .execute(quote, input, signal, onDelta)
    .catch(async (error: unknown) => {
      if (
        error instanceof UnsentOpeningError &&
        error.code === SESSION_CODES.OPENING_ABSENT
      ) {
        await disposeAbsent(state, ready);
      }
      throw error;
    });
  const after = ready.financial.snapshot();
  return {
    value,
    approval: sessionApproval({
      approvedAtomic: String(
        BigInt(after.cumulativeAtomic) - BigInt(before.cumulativeAtomic),
      ),
      cumulativeAtomic: after.cumulativeAtomic,
      depositAtomic: ready.terms.depositAtomic,
    }),
  };
}

async function renewable<Remote extends BatchDestination>(
  state: State<Remote>,
  opened: Current<Remote>,
  quote: SignedOfferV2,
  signal: AbortSignal,
  switching: boolean,
): Promise<Current<Remote>> {
  const options = state.options;
  const backend = await state.backend!;
  if (
    (await checkPreviousOpening(state, opened, signal)) &&
    !switching &&
    options.now() < opened.terms.expiresAt
  )
    return opened;
  if (!backend.renew) {
    if (switching) throw new UnsentSellerBusyError(quote.offer.nodeId);
    return opened;
  }
  if (opened.financial.snapshot().channelId)
    await opened.host.reconcile(signal);
  const snapshot = opened.financial.snapshot();
  if (
    !switching &&
    ((!snapshot.channelId && options.now() < opened.terms.expiresAt) ||
      (snapshot.state === SESSION_STATES.OPEN &&
        options.now() < opened.terms.expiresAt &&
        BigInt(snapshot.cumulativeAtomic) +
          BigInt(snapshot.reservedAtomic) +
          BigInt(quote.offer.maxAtomic) <=
          BigInt(opened.terms.depositAtomic)))
  )
    return opened;
  const proposed = newSessionTerms(quote, options.policy, options.now());
  await verifyBatchQuote(
    quote,
    proposed,
    options.endpoint.id().toString(),
    options.now(),
  );
  const stored = await options.inspect();
  if (!stored || stored.pending) return sessionFail(SESSION_CODES.UNVERIFIED);
  const authority =
    BigInt(options.policy.depositAtomic) -
    BigInt(stored.priorSpentAtomic ?? '0');
  const replacement = (spent: string) =>
    newSessionTerms(
      quote,
      {
        ...options.policy,
        depositAtomic: String(authority - BigInt(spent)),
      },
      options.now(),
    );
  if (snapshot.state !== SESSION_STATES.CLOSED)
    replacement(snapshot.cumulativeAtomic);
  const settlement = snapshot.channelId
    ? ((await opened.host.reconcile(signal)) ??
      (await opened.host.close(signal)))
    : undefined;
  const terms = replacement(settlement?.chargedAtomic ?? '0');
  await verifyBatchQuote(
    quote,
    terms,
    options.endpoint.id().toString(),
    options.now(),
  );
  signal.throwIfAborted();
  await opened.host.disconnect();
  await opened.host.settled();
  await opened.financial.dispose();
  state.current = undefined;
  await backend.renew(
    snapshot.channelId,
    terms,
    options.policy.depositAtomic,
    switching,
  );
  signal.throwIfAborted();
  return current(state, quote, signal);
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
    async checkOpening(signal: AbortSignal) {
      const opened = await current(state, undefined, signal);
      return checkPreviousOpening(state, opened, signal);
    },
    async reconcile(signal: AbortSignal) {
      const stored = await options.inspect();
      if (!stored || stored.notCreated) return undefined;
      return (await current(state, undefined, signal)).host.reconcile(signal);
    },
    async settle(signal: AbortSignal) {
      const stored = await options.inspect();
      if (!stored || stored.notCreated) return undefined;
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
