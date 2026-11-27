// Composes single-channel or shared-budget buyer sessions; all financial state stays in the adapter.
import type { AsyncLocalStorage } from 'node:async_hooks';

import {
  batchPoolChannelPaths,
  batchPoolPathsIn,
  batchSessionPathsIn,
} from '@gyblos/config/home-payments';
import type {
  BuyerApiKeyOperation,
  ConfirmKeyCharge,
} from '@gyblos/node/buyer-api-keys';
import { reviewPayment } from '@gyblos/node/buyer-payment-review';
import {
  createBuyerSessionManager,
  UnsentSellerChoiceError,
  type BuyerSessionOptions,
} from '@gyblos/node/buyer-session';
import {
  buyerSessionChain,
  buyerSessionPoolChain,
} from '@gyblos/node/buyer-session-chain';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { BUYER_PAYMENT_REVIEW } from '@gyblos/node/constants';
import { desktopOpening } from '@gyblos/node/desktop-opening';
import {
  batchSessionObserver,
  batchSessionTerminal,
  finalizedKeyCharge,
  inspectBatchPool,
  inspectBatchSession,
} from '@gyblos/payments-upto/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import type { BuyerSellerChoice } from '@gyblos/protocol/buyer-api';
import { BUYER_KEY_CODES, buyerKeyFail } from '@gyblos/protocol/buyer-api-keys';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type { ChatTokenizer } from '@gyblos/protocol/engine';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { reserveApiKey } from './api-key-execution';
import {
  observeChannelAt,
  paidChannelEligibility,
  sellerReplacementAuthorized,
} from './channel-eligibility';
import { PAID_BUYER_HTTP_MS } from './constants';
import {
  permitsWinner,
  relayAllowed,
  selectWinner,
  sellerAddress,
} from './free-selection';
import type { BuyerExecutionFactory } from './free-startup';
import { verifyBuyerIdentity } from './identity';
import { restoredSellerAddress } from './seller-address';
import {
  activeMeter,
  createSessionPreflight,
  prepareChosenMeter,
  sessionMeter,
  type BuyerStartupOptions,
} from './session-requirements';

type Context = Parameters<BuyerExecutionFactory>[0];
type Options = BuyerStartupOptions;
type Winner = Awaited<ReturnType<typeof selectWinner>>;
export interface SessionState {
  activeRequest?: (id: string, seller: string) => boolean;
  openingIntent?: AsyncLocalStorage<string | undefined>;
  selections: Map<string, Winner & { permission?: BuyerApiKeyOperation }>;
  sending: Map<string, () => void>;
  meter?: ChatTokenizer;
}
function trustedQuote(
  context: Context,
  state: SessionState,
): BuyerSessionOptions<ReturnType<typeof sellerAddress>>['verify'] {
  const { prepared } = context;
  return async (quote, signal) => {
    const selected = state.selections.get(quote.offer.requestId);
    const seller =
      selected?.seller ??
      prepared.config.sellers.find(
        (candidate) => candidate.nodeId === quote.offer.nodeId,
      );
    if (
      !selected ||
      canonicalJson(selected.quote) !== canonicalJson(quote) ||
      !seller ||
      !(await permitsWinner(prepared, selected, Date.now())) ||
      !(await verifyBuyerIdentity(prepared.identity, seller, signal))
    )
      return sessionFail(SESSION_CODES.UNVERIFIED);
    signal.throwIfAborted();
  };
}
function sessionReceipts(
  context: Context,
  state: SessionState,
): BuyerSessionOptions<ReturnType<typeof sellerAddress>>['receipt'] {
  return (evidence, quote) => {
    const selected = state.selections.get(quote.offer.requestId);
    if (selected)
      return context.dependencies.receipt?.(
        selected,
        evidence,
        new AbortController().signal,
      );
  };
}
function sessionDestination(
  context: Context,
  state: SessionState,
  policy: NonNullable<Context['prepared']['config']['session']>,
): BuyerSessionOptions<ReturnType<typeof sellerAddress>>['destination'] {
  const { prepared, relayOnly } = context;
  return (terms) => {
    const seller = prepared.config.sellers.find(
      (candidate) =>
        candidate.nodeId === terms.sellerNodeId &&
        candidate.owner === terms.owner,
    );
    const selected = [...state.selections.values()].find(
      (winner) =>
        winner.seller?.nodeId === terms.sellerNodeId &&
        winner.seller.owner === terms.owner,
    )?.seller;
    if (
      !seller &&
      !selected &&
      !prepared.identity &&
      policy.totalDepositAtomic === undefined
    )
      return sessionFail(SESSION_CODES.BINDING);
    const known = seller ?? selected;
    return known
      ? sellerAddress(known, relayOnly)
      : restoredSellerAddress(terms.sellerNodeId, terms.owner, relayOnly);
  };
}
function desktopPermissions(
  state: SessionState,
  paidAuto: boolean,
): Pick<
  BuyerSessionOptions<ReturnType<typeof sellerAddress>>,
  'financialPermission' | 'switchingAllowed' | 'onDeclined' | 'beforeInference'
> {
  return {
    financialPermission(run) {
      const id = state.openingIntent?.getStore();
      return id ? desktopOpening(process.env).whileArmed(id, run) : run();
    },
    switchingAllowed: (requestId) =>
      sellerReplacementAuthorized(
        paidAuto,
        !!state.selections.get(requestId)?.permission,
        state.openingIntent?.getStore(),
      ),
    onDeclined: async () => {
      const intent = state.openingIntent?.getStore();
      if (intent) await desktopOpening(process.env).declined(intent);
    },
    beforeInference: async (id, ref, executionDigest) => {
      await state.selections
        .get(id)
        ?.permission?.bindExecution(id, executionDigest);
      const intent = state.openingIntent?.getStore();
      if (intent) await desktopOpening(process.env).consume(intent, ref);
    },
  };
}
async function previousSeller(
  total: string | undefined,
  inspect: typeof inspectSingle,
) {
  if (total !== undefined) return undefined;
  const stored = await inspect();
  return stored && !batchSessionTerminal(stored)
    ? stored.terms.sellerNodeId
    : undefined;
}
function inspectSingle() {
  return inspectBatchSession(batchSessionPathsIn(process.env, P2P_ROLES.BUYER));
}
function keyProof(context: Context, options: Options): ConfirmKeyCharge {
  return async (ref, scope, deadline) => {
    const pool = batchPoolPathsIn(process.env);
    const entries = await inspectBatchPool(pool, { includeLegacy: false });
    const slot = entries.find(
      (entry) => entry.terms.sellerNodeId === ref.sellerNodeId,
    );
    if (entries.length && !slot) return undefined;
    const paths =
      slot && !slot.legacy
        ? batchPoolChannelPaths(pool, ref.sellerNodeId)
        : pool.legacy;
    return reviewPayment(
      (signal) =>
        finalizedKeyCharge(
          paths,
          ref,
          scope,
          context.endpoint.id().toString(),
          (terms, channelId) =>
            options.observeSettlement
              ? options.observeSettlement(channelId)
              : batchSessionObserver({
                  paths,
                  terms,
                  rpcUrl: context.role.rpcUrl,
                }).settlement(channelId, signal),
        ),
      deadline,
    );
  };
}
function pickerChannel(
  context: Context,
  options: Options,
  state: SessionState,
) {
  const config = context.prepared.config;
  return (choice: BuyerSellerChoice, signal: AbortSignal) => {
    if (context.role.role !== P2P_ROLES.BUYER)
      return sessionFail(SESSION_CODES.BINDING);
    const known = config.sellers.find(
      (seller) => seller.nodeId === choice.nodeId,
    );
    if (
      (known && known.owner !== choice.owner) ||
      (!known && !config.discovery?.open)
    )
      return Promise.resolve({
        blocker: SESSION_CODES.BINDING,
        channelRemainingAtomic: null,
      });
    return paidChannelEligibility(
      process.env,
      {
        ...choice,
        payer: context.role.buyer,
        network: config.request.network,
        mint: config.request.asset,
        maxAtomic: config.request.maxAtomic,
        pinnedNodeId: config.pinnedNodeId,
        activeRequest: state.activeRequest,
      },
      options.channelClock ?? Date.now,
      options.observeChannel ?? observeChannelAt(context.role.rpcUrl),
      signal,
    );
  };
}
function checkSelectedChannel(
  context: Context,
  options: Options,
  state: SessionState,
) {
  const { config } = context.prepared;
  const observe =
    options.observeChannel ?? observeChannelAt(context.role.rpcUrl);
  return async (
    quote: SignedOfferV2,
    signal: AbortSignal,
    intent = state.openingIntent?.getStore(),
    delegated = !!state.selections.get(quote.offer.requestId)?.permission,
  ) => {
    const result = await paidChannelEligibility(
      process.env,
      {
        ...quote.offer,
        payer: quote.offer.buyer,
        pinnedNodeId:
          config.session?.totalDepositAtomic !== undefined &&
          config.routing?.allowPinnedFallback
            ? undefined
            : config.pinnedNodeId,
        replacementAuthorized: await sellerReplacementAuthorized(
          config.discovery?.paidAuto === true,
          delegated,
          intent,
        ),
        activeRequest: state.activeRequest,
      },
      options.channelClock ?? Date.now,
      observe,
      AbortSignal.any([
        signal,
        AbortSignal.timeout(BUYER_PAYMENT_REVIEW.deadlineMs),
      ]),
    );
    if (result.blocker === BUYER_KEY_CODES.REVIEW)
      return buyerKeyFail(result.blocker);
    if (result.blocker)
      throw new UnsentSellerChoiceError(result.blocker, quote.offer.nodeId);
  };
}
function sessionAuthorization(
  state: SessionState,
): BuyerSessionOptions<ReturnType<typeof sellerAddress>>['authorizeRequest'] {
  return async (quote, signal) => {
    const permission = state.selections.get(quote.offer.requestId)?.permission;
    await reserveApiKey(permission, quote, signal);
    return permission?.releaseUnsent;
  };
}
async function unresolvedPool(totalDepositAtomic: string | undefined) {
  if (totalDepositAtomic !== undefined) return false;
  return (
    await inspectBatchPool(batchPoolPathsIn(process.env), {
      includeLegacy: false,
    })
  ).some(
    (entry) =>
      !entry.stored || entry.uncertain || !batchSessionTerminal(entry.stored),
  );
}
export function makeManager(
  context: Context,
  options: Options,
  policy: NonNullable<Context['prepared']['config']['session']>,
  state: SessionState,
) {
  const { prepared, role, endpoint, relayOnly } = context;
  const checkChannel = checkSelectedChannel(context, options, state);
  const common: Parameters<
    typeof createBuyerSessionManager<ReturnType<typeof sellerAddress>>
  >[0] = {
    policy,
    ...desktopPermissions(state, prepared.config.discovery?.paidAuto === true),
    openingSupportsBlocks:
      (policy.totalDepositAtomic !== undefined
        ? options.pool
        : options.batch) === undefined
        ? true
        : undefined,
    endpoint,
    now: Date.now,
    inspect: inspectSingle,
    backend: async () => (options.batch ?? buyerSessionChain)(role),
    destination: sessionDestination(context, state, policy),
    meter: activeMeter(state),
    transport: {
      relayOnly,
      relayAllowed,
      beforeExecute: (request) =>
        state.sending.get(request.quote.offer.requestId)?.(),
    },
    unresolved: () => unresolvedPool(policy.totalDepositAtomic),
    checkReusableChannel: checkChannel,
    authorizeRequest: sessionAuthorization(state),
    verify: trustedQuote(context, state),
    receipt: sessionReceipts(context, state),
  };
  const manager =
    policy.totalDepositAtomic !== undefined
      ? createBuyerSessionPool({
          ...common,
          inspect: () => inspectBatchPool(batchPoolPathsIn(process.env)),
          pool: () =>
            (options.pool ?? buyerSessionPoolChain)(
              role,
              policy.totalDepositAtomic!,
            ),
        })
      : createBuyerSessionManager(common);
  if ('ownsRequest' in manager) state.activeRequest = manager.ownsRequest;
  const loadMeter = sessionMeter(prepared.config.request.maxAtomic, options);
  const check = createSessionPreflight(loadMeter, policy, () =>
    context.endpoint.id().toString(),
  );
  return {
    ...manager,
    checkChannel,
    inspectChannel: pickerChannel(context, options, state),
    confirmKeyCharge: keyProof(context, options),
    previousSeller: () =>
      previousSeller(policy.totalDepositAtomic, common.inspect),
    preparePaidChat: async () => {
      await loadMeter();
    },
    prepareChoice: (expiresAt: number, signal: AbortSignal) =>
      prepareChosenMeter(expiresAt, loadMeter, signal),
    async preflight(...args: Parameters<typeof check>) {
      // A declared quote loads no meter; keep the one a recounted quote loaded.
      const meter = await check(...args);
      if (meter) state.meter = meter;
    },
  };
}
