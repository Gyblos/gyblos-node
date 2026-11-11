// Activates the shared session manager for explicit buyer policy; free quotes never build financial services.
import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { ownedChat } from './chat-owned';
import { PAID_BUYER_HTTP_MS } from './constants';
import { executeSelectedBuyerFree } from './free-execution';
import { selectWinner } from './free-selection';
import type { ChatResult } from './free-sse';
import type { BuyerExecutionFactory } from './free-startup';
import { requireBuyerIdentity } from './identity';
import { classifyPaidError } from './paid-http';
import { endpointToken, type startPaidBuyer } from './paid-startup';
import { makeManager, type SessionState } from './session-manager';

type Context = Parameters<BuyerExecutionFactory>[0];
type Options = NonNullable<Parameters<typeof startPaidBuyer>[0]>;

function sessionExecutor(
  context: Context,
  options: Options,
  manager: ReturnType<typeof makeManager>,
  state: SessionState,
  buyer: string,
): Awaited<ReturnType<BuyerExecutionFactory>>['execute'] {
  const { prepared, endpoint, relayOnly } = context;
  return async (input, signal, onDelta) => {
    const routed = await executeBuyerQuote<ChatResult>(
      {
        enter: context.dependencies.enter ?? (() => () => {}),
        unresolved: manager.unresolved,
        select: (excluded, current) =>
          selectWinner(
            prepared,
            {
              endpoint,
              buyer,
              relayOnly,
              onSellerFailure: options.onSellerFailure,
            },
            excluded,
            current,
            prepared.config.request,
          ),
        free: (winner, current) =>
          executeSelectedBuyerFree(
            input,
            context.dependencies,
            winner,
            current,
            onDelta,
          ),
        paid: async (winner, current) => {
          state.selected = winner;
          const result = await manager.execute(winner.quote, input, current);
          if (onDelta && result.value.text)
            await onDelta(result.value.text, winner.quote.offer.requestDigest);
          return {
            ...result.value,
            payment: {
              verdict: SESSION_VERDICTS.APPROVED,
              maxAtomic: winner.quote.offer.maxAtomic,
              expectedAtomic: result.approval.approvedAtomic,
              chargedAtomic: null,
              sellerAtomic: null,
              feeAtomic: null,
              refundedAtomic: null,
              recorded: true,
              session: result.approval,
            },
          };
        },
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
  const state: SessionState = {};
  const manager = makeManager(context, options, policy, state);
  return {
    token,
    requestMs: PAID_BUYER_HTTP_MS,
    classify: classifyPaidError,
    execute: sessionExecutor(context, options, manager, state, role.buyer),
    chat: (url) => ({
      ...ownedChat(
        prepared.config.request.selection.modelId,
        prepared.config.request.maxTokens,
        prepared.config.request.maxAtomic,
        url,
        token,
        {
          ...policy,
          settle: () => manager.settle(AbortSignal.timeout(PAID_BUYER_HTTP_MS)),
        },
      ),
      automatic: true,
    }),
    inspect: (_digest, signal = AbortSignal.timeout(PAID_BUYER_HTTP_MS)) =>
      manager.reconcile(signal),
    close: manager.close,
  };
}
