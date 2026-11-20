// Routes session-enabled buyers and preserves free inference for older free-only profiles.
import { buyerPaymentsUnresolved } from '@gyblos/node/buyer-chain';
import { bounded } from '@gyblos/node/buyer-operation';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { inferenceNeedsTools } from '@gyblos/protocol/inference';

import { executeApiKeyFree } from './api-key-execution';
import { withBuyerApiKeys } from './api-key-runtime';
import { ownedChat } from './chat-owned';
import { PAID_BUYER, PAID_BUYER_CODES, PAID_BUYER_HTTP_MS } from './constants';
import { executeSelectedBuyerFree } from './free-execution';
import { selectWinner, type FreeSelectionOptions } from './free-selection';
import type { ChatResult } from './free-sse';
import type { BuyerExecutionFactory } from './free-startup';
import { onBuyerSelectionFailure } from './free-telemetry';
import { routedRequest } from './model-routes';
import { selectConfiguredThenOpen } from './quote-selection';
import type { BuyerSelectionConfig } from './selection-config';
import { classifyPaidError } from './session-errors';
import {
  endpointToken,
  type BuyerStartupOptions,
} from './session-requirements';
import { startSessionQuoteRuntime } from './session-startup';

type Options = BuyerStartupOptions;
type Context = Parameters<BuyerExecutionFactory>[0];
type Runtime = Awaited<ReturnType<BuyerExecutionFactory>>;

function admission(enter: Context['dependencies']['enter']) {
  let closed = false;
  let active = false;
  let idle = Promise.resolve();
  let finish = () => {};
  return {
    enter() {
      if (closed) throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
      if (active) throw new PaidBuyerError(PAID_BUYER_CODES.BUSY);
      const release = enter?.();
      active = true;
      idle = new Promise((resolve) => {
        finish = resolve;
      });
      return () => {
        active = false;
        release?.();
        finish();
      };
    },
    stop() {
      closed = true;
      return idle;
    },
  };
}
function drain(state: ReturnType<typeof admission>) {
  return bounded(state.stop(), AbortSignal.timeout(PAID_BUYER.drainMs)).then(
    () => true,
    () => false,
  );
}
async function selectQuoted(
  context: Context,
  selection: FreeSelectionOptions,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
  request: BuyerSelectionConfig['request'],
) {
  return selectConfiguredThenOpen(
    context.prepared.config,
    request,
    signal,
    (policy, route) =>
      selectWinner(
        context.prepared,
        selection,
        excluded,
        signal,
        policy,
        route,
      ),
  );
}
function quoteExecutor(
  context: Context,
  options: Options,
  state: ReturnType<typeof admission>,
  buyer: string,
): Runtime['execute'] {
  return async (input, signal, onDelta, model, permission) => {
    const request = routedRequest(context.prepared.config.request, model);
    const routed = await executeBuyerQuote<ChatResult>(
      {
        enter: state.enter,
        unresolved: () => buyerPaymentsUnresolved(),
        select: (excluded, selectionSignal) =>
          selectQuoted(
            context,
            {
              endpoint: context.endpoint,
              buyer,
              relayOnly: context.relayOnly,
              onSellerFailure: options.onSellerFailure,
            },
            excluded,
            selectionSignal,
            {
              ...request,
              maxAtomic:
                permission?.ceiling(request.maxAtomic) ?? request.maxAtomic,
              ...(inferenceNeedsTools(input) ? { tools: true } : {}),
            },
          ).catch(
            onBuyerSelectionFailure(
              selectionSignal,
              context.dependencies,
              Boolean(onDelta),
              model?.selection,
            ),
          ),
        free: (winner, executionSignal) =>
          executeApiKeyFree(permission, winner.quote, executionSignal, () =>
            executeSelectedBuyerFree(
              input,
              context.dependencies,
              winner,
              executionSignal,
              onDelta,
            ),
          ),
        paid: async () => {
          throw new PaidBuyerError(PAID_BUYER_CODES.UNSUPPORTED);
        },
      },
      signal,
    );
    return { ...routed.result, execution: routed.kind };
  };
}
async function startQuoteRuntime(
  context: Context,
  options: Options,
): Promise<Runtime> {
  if (context.prepared.config.session)
    return startSessionQuoteRuntime(context, options);
  if (context.role.role !== P2P_ROLES.BUYER || !context.role.buyer)
    throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
  const buyer = context.role.buyer;
  const token = await endpointToken();
  const state = admission(context.dependencies.enter);

  const { request } = context.prepared.config;
  return {
    execute: quoteExecutor(context, options, state, buyer),
    token,
    requestMs: PAID_BUYER_HTTP_MS,
    classify: classifyPaidError,
    chat: (url) => ({
      ...ownedChat(
        request.selection.modelId,
        request.maxTokens,
        request.maxAtomic,
        url,
        token,
      ),
      automatic: true,
    }),
    drain: () => drain(state),
    close: async () => {
      await drain(state);
    },
  };
}
export function quoteBuyerExecution(options: Options): BuyerExecutionFactory {
  return async (context) =>
    withBuyerApiKeys(await startQuoteRuntime(context, options), context);
}
