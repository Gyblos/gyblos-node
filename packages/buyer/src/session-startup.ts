// Activates the shared session manager for explicit buyer policy; free quotes never build financial services.
import { AsyncLocalStorage } from 'node:async_hooks';

import { parseBuyerRoutingPolicy } from '@gyblos/core/buyer-routing';
import type { BuyerApiKeyOperation } from '@gyblos/node/buyer-api-keys';
import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import type { BuyerRoutePorts } from '@gyblos/node/buyer-routing';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { withBatchOutputLimit } from '@gyblos/protocol/batch-channel';
import type { BuyerSellerChoice } from '@gyblos/protocol/buyer-api';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { inferenceNeedsTools } from '@gyblos/protocol/inference';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import {
  executeApiKeyFree,
  executeApiKeySession,
  recordApiKeyPayment,
  reserveApiKey,
} from './api-key-execution';
import { ownedChat } from './chat-owned';
import { PAID_BUYER_HTTP_MS } from './constants';
import { observeBuyerExecution } from './execution-observation';
import type { SelectionRoute } from './free-route';
import { selectWinner } from './free-selection';
import type { ChatPayment, ChatResult } from './free-sse';
import type { BuyerExecutionFactory } from './free-startup';
import { onBuyerSelectionFailure } from './free-telemetry';
import { requireBuyerIdentity } from './identity';
import { routedRequest } from './model-routes';
import {
  automaticPoolRoute,
  delegatedFreeResends,
  openDiscoveryRequest,
  selectAffordableAutoQuote,
  selectConfiguredThenOpen,
} from './quote-selection';
import { classifyPaidError } from './session-errors';
import { fittingSelect, freeSessionExecution } from './session-free';
import { makeManager, type SessionState } from './session-manager';
import {
  checkDesktopPool,
  checkPaidSellerRequest,
  endpointToken,
  type BuyerStartupOptions,
} from './session-requirements';
import { pinnedBusy, routeScope, sessionRouter } from './session-routing';
import {
  preferChannel,
  prepareChosenSeller,
  verifyChosenOffer,
} from './session-seller-choice';
import { singleSessionExecutor } from './session-serial';

type Context = Parameters<BuyerExecutionFactory>[0];

async function executePaidSession(
  manager: ReturnType<typeof makeManager>,
  state: SessionState,
  winner: Parameters<BuyerRoutePorts<ChatResult>['paid']>[0],
  input: Parameters<Awaited<ReturnType<BuyerExecutionFactory>>['execute']>[0],
  current: AbortSignal,
  onDelta?: (text: string, requestDigest?: string) => Promise<void>,
  sending?: () => void,
  permission?: BuyerApiKeyOperation,
  openingIntent?: string,
): Promise<ChatResult> {
  const { quote } = winner;
  current.throwIfAborted();
  await manager.preflight(quote, input, current);
  current.throwIfAborted();
  await manager.checkChannel(quote, current, openingIntent, !!permission);
  current.throwIfAborted();
  const id = quote.offer.requestId;
  if (state.selections.has(id)) return sessionFail(SESSION_CODES.BINDING);
  const scope = (state.openingIntent ??= new AsyncLocalStorage<
    string | undefined
  >());
  state.selections.set(id, { ...winner, permission });
  if (sending) state.sending.set(id, sending);
  let result: Awaited<ReturnType<typeof manager.execute>>;
  try {
    result = await scope.run(openingIntent, () =>
      executeApiKeySession(permission, winner.nodeId, () =>
        manager.execute(
          winner.quote,
          input,
          current,
          onDelta
            ? (text) => onDelta(text, winner.quote.offer.requestDigest)
            : undefined,
        ),
      ),
    );
  } finally {
    state.selections.delete(id);
    state.sending.delete(id);
  }
  const payment: ChatPayment = {
    verdict: SESSION_VERDICTS.APPROVED,
    maxAtomic: winner.quote.offer.maxAtomic,
    expectedAtomic: result.approval.approvedAtomic,
    chargedAtomic: null,
    sellerAtomic: null,
    feeAtomic: null,
    refundedAtomic: null,
    recorded: true,
    session: result.approval,
  };
  await recordApiKeyPayment(permission, payment);
  return { ...result.value, payment };
}
function sessionSelection(
  context: Context,
  options: BuyerStartupOptions,
  buyer: string,
  getRequest: () => Context['prepared']['config']['request'],
  input: Parameters<Awaited<ReturnType<BuyerExecutionFactory>>['execute']>[0],
  permission: Parameters<typeof reserveApiKey>[0],
  router: ReturnType<typeof sessionRouter> | undefined,
  previousSeller: () => Promise<string | undefined>,
  choice?: BuyerSellerChoice,
): BuyerRoutePorts<ChatResult>['select'] {
  const { prepared, endpoint, relayOnly } = context;
  return (
    excluded: Set<string>,
    current: AbortSignal,
    route: Parameters<BuyerRoutePorts<ChatResult>['select']>[2],
  ) => {
    const request = getRequest();
    const policy = {
      ...request,
      maxAtomic: permission?.ceiling(request.maxAtomic) ?? request.maxAtomic,
      priceCeilings:
        request.maxAtomic === '0' ? request.priceCeilings : route.priceCeilings,
      ...(inferenceNeedsTools(input) ? { tools: true as const } : {}),
    };
    const select = async (
      candidate: typeof request,
      selectionRoute?: SelectionRoute,
    ) =>
      selectWinner(
        prepared,
        {
          endpoint,
          buyer,
          relayOnly,
          onSellerFailure: options.onSellerFailure,
          ...(router ? { onPinnedBusy: pinnedBusy } : {}),
        },
        excluded,
        current,
        candidate,
        await preferChannel(
          selectionRoute,
          prepared.config.discovery?.paidAuto,
          previousSeller,
        ),
      );
    if (choice) {
      if (permission) return sessionFail(SESSION_CODES.BINDING);
      const chosen = prepareChosenSeller(prepared, choice);
      return selectWinner(
        chosen.prepared,
        { endpoint, buyer, relayOnly },
        excluded,
        current,
        options.desktopChosenPrices
          ? {
              ...policy,
              priceCeilings: {
                inputAtomicPerMtok: choice.inputAtomicPerMtok,
                outputAtomicPerMtok: choice.outputAtomicPerMtok,
              },
            }
          : policy,
        { pinnedNodeId: choice.nodeId },
      ).then((winner) => {
        verifyChosenOffer(choice, winner);
        return { ...winner, seller: chosen.seller };
      });
    }
    if (router || route.pinnedNodeId)
      return select(
        prepared.config.discovery?.paidAuto
          ? openDiscoveryRequest(policy, true)
          : policy,
        automaticPoolRoute(prepared.config, route),
      );
    return selectConfiguredThenOpen(prepared.config, policy, current, select);
  };
}
function executeSingleRoute(
  ports: BuyerRoutePorts<ChatResult>,
  dependencies: Context['dependencies'],
  unresolved: ReturnType<typeof makeManager>['unresolved'],
  request: Context['prepared']['config']['request'],
  pinnedNodeId: string | undefined,
  streaming: boolean,
  selection: typeof request.selection | undefined,
  signal: AbortSignal,
) {
  return executeBuyerQuote(
    {
      ...ports,
      enter: dependencies.enter ?? (() => () => {}),
      unresolved,
      select: (excluded, current) =>
        ports
          .select(excluded, current, {
            pinnedNodeId,
            priceCeilings: request.priceCeilings,
          })
          .catch(
            onBuyerSelectionFailure(
              current,
              dependencies,
              streaming,
              selection,
            ),
          ),
    },
    signal,
  );
}
function sessionExecutor(
  context: Context,
  options: BuyerStartupOptions,
  manager: ReturnType<typeof makeManager>,
  state: SessionState,
  buyer: string,
  router?: ReturnType<typeof sessionRouter>,
): Awaited<ReturnType<BuyerExecutionFactory>>['execute'] {
  return async (input, signal, onDelta, model, permission) => {
    const config = context.prepared.config;
    const request = routedRequest(config.request, model);
    if (model?.sellerChoice && !permission && request.maxAtomic !== '0')
      await manager.prepareChoice(model.sellerChoice.expiresAt, signal);
    const retries = delegatedFreeResends(
      Boolean(permission && context.dependencies.resendAfterSend),
    );
    const select = sessionSelection(
      context,
      options,
      buyer,
      () => retries.request(request),
      input,
      permission,
      router,
      manager.previousSeller,
      model?.sellerChoice,
    );
    let unfit = false;
    const paidInput = withBatchOutputLimit(input);
    const ports: BuyerRoutePorts<ChatResult> = {
      takeFreeResend: retries.takeFreeResend,
      select: fittingSelect(
        config.discovery?.paidAuto && !model?.sellerChoice
          ? (excluded, current, route) =>
              selectAffordableAutoQuote(
                excluded,
                current,
                (skip) => select(skip, current, route),
                (quote) => manager.preflight(quote, paidInput, current),
              )
          : select,
        input,
        () => {
          unfit = true;
        },
        parseBuyerRoutingPolicy(config.routing),
      ),
      free: freeSessionExecution(
        context,
        manager,
        input,
        permission,
        onDelta,
        () => {
          unfit = true;
        },
        retries,
      ),
      paid: (winner, current, sending) => {
        if (retries.failure()) throw retries.failure();
        if (model?.freeOnly) return sessionFail(SESSION_CODES.LIMIT);
        return observeBuyerExecution(
          context.dependencies,
          winner,
          paidInput,
          current,
          onDelta,
          (emit) => {
            checkPaidSellerRequest(request, context.role, winner.quote);
            return executePaidSession(
              manager,
              state,
              winner,
              paidInput,
              current,
              emit,
              sending,
              permission,
              model?.openingIntent,
            );
          },
        );
      },
    };
    const routed = await (
      router && !model?.sellerChoice
        ? router.execute(ports, signal, routeScope(request))
        : executeSingleRoute(
            ports,
            context.dependencies,
            manager.unresolved,
            request,
            config.pinnedNodeId,
            Boolean(onDelta),
            model?.selection,
            signal,
          )
    ).catch((error: unknown) => {
      throw retries.selectionError(error, unfit);
    });
    return { ...routed.result, execution: routed.kind };
  };
}
export async function startSessionQuoteRuntime(
  context: Context,
  options: BuyerStartupOptions,
): Promise<Awaited<ReturnType<BuyerExecutionFactory>>> {
  const { prepared, role } = context;
  const policy = prepared.config.session;
  if (!policy || role.role !== P2P_ROLES.BUYER || !role.buyer)
    return sessionFail();
  requireBuyerIdentity(prepared.config, prepared.identity);
  const token = await endpointToken();
  const state: SessionState = {
    selections: new Map(),
    sending: new Map(),
  };
  const manager = makeManager(context, options, policy, state);
  const router =
    policy.totalDepositAtomic === undefined
      ? undefined
      : sessionRouter(context, manager.unresolved);
  const inspect = (run: () => ReturnType<typeof manager.reconcile>) => {
    if (router?.activeRequests()) return sessionFail(SESSION_CODES.BUSY);
    return run();
  };
  const buyer = role.buyer;
  const execute = sessionExecutor(
    context,
    options,
    manager,
    state,
    buyer,
    router,
  );
  return {
    confirmKeyCharge: manager.confirmKeyCharge,
    inspectChannel: manager.inspectChannel,
    sellerChoice: true,
    reconcilePool: router
      ? () => checkDesktopPool(manager, () => router.activeRequests() > 0)
      : undefined,
    preparePaidChat:
      options.preparePaidTokenizer && prepared.config.request.maxAtomic !== '0'
        ? manager.preparePaidChat
        : undefined,
    token,
    requestMs: PAID_BUYER_HTTP_MS,
    classify: classifyPaidError,
    execute: router ? execute : singleSessionExecutor(execute),
    chat: (url) => ({
      ...ownedChat(
        prepared.config.request.selection.modelId,
        prepared.config.request.maxTokens,
        prepared.config.request.maxAtomic,
        url,
        token,
        {
          ...policy,
          settle: () =>
            inspect(() =>
              manager.settle(AbortSignal.timeout(PAID_BUYER_HTTP_MS)),
            ),
        },
      ),
      automatic: true,
    }),
    inspect: (_digest, signal = AbortSignal.timeout(PAID_BUYER_HTTP_MS)) =>
      inspect(() => manager.reconcile(signal)),
    drain: router?.close,
    close: async () => {
      await router?.close();
      await manager.close();
    },
  };
}
