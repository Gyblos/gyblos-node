// Activates the shared session manager for explicit buyer policy; free quotes never build financial services.
import type { BuyerApiKeyOperation } from '@gyblos/node/buyer-api-keys';
import { bounded } from '@gyblos/node/buyer-operation';
import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import type { BuyerRoutePorts } from '@gyblos/node/buyer-routing';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import {
  executeApiKeyFree,
  executeApiKeySession,
  recordApiKeyPayment,
  reserveApiKey,
} from './api-key-execution';
import { ownedChat } from './chat-owned';
import { PAID_BUYER_HTTP_MS } from './constants';
import { executeSelectedBuyerFree } from './free-execution';
import { selectWinner } from './free-selection';
import type { ChatPayment, ChatResult } from './free-sse';
import type { BuyerExecutionFactory } from './free-startup';
import { requireBuyerIdentity } from './identity';
import { classifyPaidError } from './paid-http';
import { endpointToken, type startPaidBuyer } from './paid-startup';
import { makeManager, type SessionState } from './session-manager';
import { pinnedBusy, sessionRouter } from './session-routing';

type Context = Parameters<BuyerExecutionFactory>[0];
type Options = NonNullable<Parameters<typeof startPaidBuyer>[0]>;

async function executePaidSession(
  manager: ReturnType<typeof makeManager>,
  state: SessionState,
  winner: Parameters<BuyerRoutePorts<ChatResult>['paid']>[0],
  input: Parameters<Awaited<ReturnType<BuyerExecutionFactory>>['execute']>[0],
  current: AbortSignal,
  onDelta?: (text: string, requestDigest?: string) => Promise<void>,
  sending?: () => void,
  permission?: BuyerApiKeyOperation,
): Promise<ChatResult> {
  current.throwIfAborted();
  await bounded(manager.prepareMeter(), current);
  current.throwIfAborted();
  await reserveApiKey(permission, winner.quote, current);
  const id = winner.quote.offer.requestId;
  if (state.selections.has(id)) return sessionFail(SESSION_CODES.BINDING);
  state.selections.set(id, winner);
  if (sending) state.sending.set(id, sending);
  let result: Awaited<ReturnType<typeof manager.execute>>;
  try {
    result = await executeApiKeySession(permission, winner.nodeId, () =>
      manager.execute(winner.quote, input, current),
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
  if (onDelta && result.value.text)
    await onDelta(result.value.text, winner.quote.offer.requestDigest);
  return { ...result.value, payment };
}
function sessionExecutor(
  context: Context,
  options: Options,
  manager: ReturnType<typeof makeManager>,
  state: SessionState,
  buyer: string,
  router?: ReturnType<typeof sessionRouter>,
): Awaited<ReturnType<BuyerExecutionFactory>>['execute'] {
  const { prepared, endpoint, relayOnly } = context;
  return async (input, signal, onDelta, permission) => {
    const ports: BuyerRoutePorts<ChatResult> = {
      select: (excluded, current, route) =>
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
          {
            ...prepared.config.request,
            priceCeilings: route.priceCeilings,
            maxAtomic:
              permission?.ceiling(prepared.config.request.maxAtomic) ??
              prepared.config.request.maxAtomic,
          },
          route,
        ),
      free: (winner, current, sending) =>
        executeApiKeyFree(permission, winner.quote, current, () =>
          executeSelectedBuyerFree(
            input,
            context.dependencies,
            winner,
            current,
            onDelta,
            () => {
              if ('checkBeforeExternalExecution' in manager)
                manager.checkBeforeExternalExecution();
              sending?.();
            },
          ),
        ),
      paid: async (winner, current, sending) => {
        return executePaidSession(
          manager,
          state,
          winner,
          input,
          current,
          onDelta,
          sending,
          permission,
        );
      },
    };
    const routed = router
      ? await router.execute(ports, signal)
      : await executeBuyerQuote(
          {
            ...ports,
            enter: context.dependencies.enter ?? (() => () => {}),
            unresolved: manager.unresolved,
            select: (excluded, current) =>
              ports.select(excluded, current, {
                pinnedNodeId: prepared.config.pinnedNodeId,
                priceCeilings: prepared.config.request.priceCeilings,
              }),
          },
          signal,
        );
    return { ...routed.result, execution: routed.kind };
  };
}
export async function startSessionQuoteRuntime(
  context: Context,
  options: Options,
): Promise<Awaited<ReturnType<BuyerExecutionFactory>>> {
  const { prepared, role } = context;
  const policy = prepared.config.session;
  if (!policy || role.role !== P2P_ROLES.BUYER || !role.buyer)
    return sessionFail();
  requireBuyerIdentity(prepared.config, prepared.identity);
  const token = await endpointToken();
  const state: SessionState = { selections: new Map(), sending: new Map() };
  const manager = makeManager(context, options, policy, state);
  const router =
    policy.totalDepositAtomic === undefined
      ? undefined
      : sessionRouter(context, manager.unresolved);
  const inspect = (run: () => ReturnType<typeof manager.reconcile>) => {
    if (router?.activeRequests()) return sessionFail(SESSION_CODES.BUSY);
    return run();
  };
  return {
    token,
    requestMs: PAID_BUYER_HTTP_MS,
    classify: classifyPaidError,
    execute: sessionExecutor(
      context,
      options,
      manager,
      state,
      role.buyer,
      router,
    ),
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
