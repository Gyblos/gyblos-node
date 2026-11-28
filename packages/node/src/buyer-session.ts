// One explicitly authorized reusable session for shared buyer hosts; no selection or prompt retry.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import type { BatchStoredSession } from '@gyblos/payments-upto/batch-session';
import { BuyerApiKeyError } from '@gyblos/protocol/buyer-api-keys';
import { CONTROL_METERING_MODES } from '@gyblos/protocol/constants';
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
import type { BuyerBatchSessionOptions } from './batch-buyer-types';
import {
  channelTurnAuthority,
  prepareNewChannel,
  UnsentChannelRequestError,
  verifyOpeningQuote,
  type PreparedChannel,
  type StartChannelWork,
} from './buyer-channel-prepare';
import { UnsentOpeningError } from './buyer-opening-retry';
import {
  checkFundedChannel,
  checkPreviousOpening,
  disconnectChannel,
  disposeAbsent,
} from './buyer-opening-state';
import { bounded } from './buyer-operation';
import { UnsentSellerBusyError } from './buyer-routing';
import {
  checkInterruptedQuestion,
  prepareRenewal,
  verifyPreparationRefusal,
  verifyQuestion,
} from './buyer-session-renewal';
import { sessionApproval } from './session-accounting';
import type { BuyerSessionBackend } from './session-backend';
import {
  checkChannelAuthority,
  newSessionTerms,
  parseBuyerSessionPolicy,
  replacementTerms,
  spendingAuthority,
  UnsentChannelLimitError,
  type BuyerSessionPolicy,
} from './session-policy';

export {
  UnsentSellerChoiceError,
  UnsentChannelRequestError,
} from './buyer-channel-prepare';

export interface BuyerSessionOptions<Remote extends BatchDestination> {
  // Known capability of the financial adapter. Unspecified adapters negotiate after construction.
  financialPermission?: BuyerBatchSessionOptions<Remote>['financialPermission'];
  authorizeRequest?: (
    quote: SignedOfferV2,
    signal: AbortSignal,
  ) => Promise<(() => Promise<void>) | undefined>;
  credentialId?: BuyerBatchSessionOptions<Remote>['credentialId'];
  onDeclined?: BuyerBatchSessionOptions<Remote>['onDeclined'];
  beforeInference?: BuyerBatchSessionOptions<Remote>['beforeInference'];
  checkReusableChannel?: BuyerSessionOptions<Remote>['verify'];
  switchingAllowed?(requestId: string): Promise<boolean>;
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
  start: StartChannelWork,
) {
  if (!state.backend) {
    const pending = start(() => state.options.backend());
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
  start: StartChannelWork,
): Promise<Current<Remote>> {
  const options = state.options;
  const stored = await bounded(options.inspect(), signal);
  checkFundedChannel(options.policy.fundedChannelId, stored, quote);
  if (stored?.notCreated || stored?.openingReturned) {
    if (!quote) return sessionFail(SESSION_CODES.CLOSED);
    const replacement = replacementTerms(
      options.policy,
      options.now,
      quote,
      stored.priorSpentAtomic,
    )('0');
    await verifyOpeningQuote(options, quote, replacement);
    const switching =
      stored.terms.sellerNodeId !== replacement.sellerNodeId &&
      (await options.switchingAllowed?.(quote.offer.requestId));
    const backend = await getBackend(state, signal, start);
    const renew = backend.renew?.bind(backend);
    if (!renew) return sessionFail(SESSION_CODES.CLOSED);
    await start(() =>
      renew(
        stored.snapshot.channelId,
        replacement,
        spendingAuthority(options.policy),
        switching,
      ),
    );
    const renewed = await options.inspect();
    if (!renewed || renewed.notCreated || renewed.openingReturned)
      return sessionFail(SESSION_CODES.UNVERIFIED);
    return openCurrent(state, quote, signal, start);
  }
  const terms =
    stored?.terms ??
    (quote ? newSessionTerms(quote, options.policy, options.now()) : undefined);
  if (!terms) return sessionFail(SESSION_CODES.UNAVAILABLE);
  if (quote && !stored) await verifyOpeningQuote(options, quote, terms);
  const preparation =
    quote && !stored && options.openingSupportsBlocks !== undefined
      ? await start(() => prepareNewChannel(options, quote, terms, signal))
      : options.preparation;
  signal.throwIfAborted();
  const destination = options.destination(terms);
  const backend = await getBackend(state, signal, start);
  signal.throwIfAborted();
  const financial = await start(() => backend.create(terms));
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
        declared: quote?.offer.meteringMode === CONTROL_METERING_MODES.DECLARED,
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
  start: StartChannelWork = (work) => work(),
) {
  if (!state.current) {
    const pending = openCurrent(state, quote, signal, start);
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
  signal: AbortSignal,
  start: StartChannelWork,
  onDelta?: (text: string) => Promise<void>,
) {
  const { options } = state;
  await verifyQuestion(state, quote, input, signal);
  const opened = await current(state, quote, signal, start);
  checkChannelAuthority(
    options.policy,
    opened.terms,
    opened.priorSpentAtomic,
    options.now(),
    quote.offer.nodeId,
  );
  const switching =
    opened.terms.sellerNodeId !== quote.offer.nodeId ||
    opened.terms.owner !== quote.offer.owner;
  if (switching && !(await options.switchingAllowed?.(quote.offer.requestId)))
    throw new UnsentSellerBusyError(quote.offer.nodeId);
  const renew = () => renewable(state, opened, quote, signal, switching, start);
  const ready =
    switching && options.financialPermission
      ? await options.financialPermission(renew)
      : await renew();
  const before = ready.financial.snapshot();
  if (before.channelId) await options.checkReusableChannel?.(quote, signal);
  const value = await start(() =>
    ready.host.execute(quote, input, signal, onDelta),
  ).catch(async (error: unknown) => {
    await verifyPreparationRefusal(error, options.inspect, quote.offer.nodeId);
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
  start: StartChannelWork,
): Promise<Current<Remote>> {
  const backend = await state.backend!;
  const plan = await prepareRenewal(
    state,
    opened,
    quote,
    signal,
    switching,
    !!backend.renew,
    start,
  ).catch((cause: unknown) => {
    if (
      signal.aborted ||
      !switching ||
      cause instanceof BuyerApiKeyError ||
      cause instanceof UnsentSellerBusyError ||
      cause instanceof UnsentChannelLimitError
    )
      throw cause;
    throw new UnsentChannelRequestError(quote.offer.nodeId, cause);
  });
  if (!plan) return opened;
  state.current = undefined;
  await start(() =>
    backend.renew!(
      plan.channelId,
      plan.terms,
      spendingAuthority(state.options.policy),
      switching,
    ),
  );
  signal.throwIfAborted();
  await plan.verify();
  return current(state, quote, signal, start);
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
    checkInterruptedQuestion: (
      input: FreeExecutionBuildInput,
      keyId: string | undefined,
      signal: AbortSignal,
    ) => checkInterruptedQuestion(options.inspect, input, keyId, signal),
    unresolved: () => unresolved(state),
    async execute(
      quote: SignedOfferV2,
      data: FreeExecutionBuildInput,
      signal: AbortSignal,
      onDelta?: (text: string) => Promise<void>,
    ) {
      if (state.active) return sessionFail(SESSION_CODES.BUSY);
      const currentSignal = AbortSignal.any([signal, state.lifetime.signal]);
      const authority = channelTurnAuthority(
        options.authorizeRequest,
        quote,
        currentSignal,
      );
      state.active = true;
      try {
        return await run(
          state,
          quote,
          data,
          currentSignal,
          authority.start,
          onDelta,
        );
      } finally {
        await authority.settled();
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
      if (opened) await disconnectChannel(opened);
    },
  };
}
