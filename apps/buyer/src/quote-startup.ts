// Composes automatic routing from verified quotes; payment preparation is lazy and never needed by free execution.
import { PROTOCOL_FEE } from '@gyblos/config';
import {
  buyerChainPayments,
  buyerPaymentsUnresolved,
} from '@gyblos/node/buyer-chain';
import { bounded } from '@gyblos/node/buyer-operation';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import { executeSelectedBuyerPaid } from '@gyblos/node/buyer-paid-execution';
import { executeBuyerQuote } from '@gyblos/node/buyer-quote-execution';
import { rolePath } from '@gyblos/node/roles';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import { inferenceNeedsTools } from '@gyblos/protocol/inference';

import { ownedChat } from './chat-owned';
import { PAID_BUYER, PAID_BUYER_CODES, PAID_BUYER_HTTP_MS } from './constants';
import { observeBuyerExecution } from './execution-observation';
import { executeSelectedBuyerFree } from './free-execution';
import { selectWinner } from './free-selection';
import type { ChatResult } from './free-sse';
import type { BuyerExecutionFactory } from './free-startup';
import { buyerUnserved } from './free-telemetry';
import { routedRequest } from './model-routes';
import { classifyPaidError, PaidOutcomeError, paidSummary } from './paid-http';
import { paidRecords } from './paid-records';
import { paidBuyerDependencies } from './paid-selection';
import {
  checkPaidRequest,
  endpointToken,
  payments,
  tokenizer,
  type startPaidBuyer,
} from './paid-startup';
import { startSessionQuoteRuntime } from './session-startup';

type Options = NonNullable<Parameters<typeof startPaidBuyer>[0]>;
type Context = Parameters<BuyerExecutionFactory>[0];
type Runtime = Awaited<ReturnType<BuyerExecutionFactory>>;

function admission(enter: Context['dependencies']['enter']) {
  let closed = false;
  let active = false;
  let idle = Promise.resolve();
  let finish = () => {};
  return {
    closed: () => closed,
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
async function preparePaid(
  context: Context,
  options: Options,
  state: ReturnType<typeof admission>,
  buyer: string,
  signal: AbortSignal,
  input: import('@gyblos/protocol/free-execution').FreeExecutionBuildInput,
) {
  const { prepared, role, endpoint, relayOnly } = context;
  checkPaidRequest(prepared, role);
  const meter = await (options.meter ?? tokenizer)();
  if (inferenceNeedsTools(input)) {
    if (
      !('chat' in meter) ||
      typeof meter.chat !== 'function' ||
      !('output' in meter) ||
      typeof meter.output !== 'function'
    )
      throw new PaidBuyerError(PAID_BUYER_CODES.UNSUPPORTED);
  }
  signal.throwIfAborted();
  if (state.closed()) throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
  const chain = await payments(
    options.chain ?? buyerChainPayments(),
    role,
    prepared.config.request.maxAtomic,
  );
  try {
    signal.throwIfAborted();
    if (state.closed()) throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
    const paid = paidBuyerDependencies(prepared, {
      endpoint,
      buyer,
      relayOnly,
      onSellerFailure: options.onSellerFailure,
      payment: chain.client,
      fee: PROTOCOL_FEE,
      meter,
      record: paidRecords(rolePath(P2P_ROLES.BUYER, PAID_BUYER.recordsFile))
        .record,
    });
    return { chain, paid };
  } catch (error) {
    await chain.close();
    throw error;
  }
}
function lazyPaid(
  context: Context,
  options: Options,
  state: ReturnType<typeof admission>,
  buyer: string,
) {
  let pending: ReturnType<typeof preparePaid> | undefined;
  let opened: Awaited<ReturnType<typeof preparePaid>> | undefined;

  return {
    get(
      signal: AbortSignal,
      input: import('@gyblos/protocol/free-execution').FreeExecutionBuildInput,
    ) {
      signal.throwIfAborted();
      if (state.closed())
        throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
      pending ??= preparePaid(context, options, state, buyer, signal, input)
        .then(async (runtime) => {
          if (state.closed() || signal.aborted) {
            await runtime.chain.close();
            signal.throwIfAborted();
            throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
          }
          opened = runtime;
          return runtime;
        })
        .catch((error: unknown) => {
          pending = undefined;
          throw error;
        });
      return bounded(pending, signal);
    },
    unresolved: () =>
      pending
        ? pending.then((runtime) => runtime.paid.unresolved())
        : buyerPaymentsUnresolved(),
    async inspect(digest: string, signal?: AbortSignal) {
      const drained = await drain(state);
      return drained ? opened?.chain.observe?.(digest, signal) : undefined;
    },
    drain: () => drain(state),
    // Endpoint closure precedes journal closure; an unfinished prepare owns its late cleanup.
    close: async () => {
      await opened?.chain.close();
    },
  };
}
function quoteExecutor(
  context: Context,
  options: Options,
  state: ReturnType<typeof admission>,
  paid: ReturnType<typeof lazyPaid>,
  buyer: string,
): Runtime['execute'] {
  return async (input, signal, onDelta, model) => {
    const routed = await executeBuyerQuote<ChatResult>(
      {
        enter: state.enter,
        unresolved: paid.unresolved,
        select: (excluded, selectionSignal) =>
          selectWinner(
            context.prepared,
            {
              endpoint: context.endpoint,
              buyer,
              relayOnly: context.relayOnly,
              onSellerFailure: options.onSellerFailure,
            },
            excluded,
            selectionSignal,
            {
              ...routedRequest(context.prepared.config.request, model),
              ...(inferenceNeedsTools(input) ? { tools: true } : {}),
            },
          ).catch((error) => {
            if (!selectionSignal.aborted)
              buyerUnserved(
                context.dependencies,
                Boolean(onDelta),
                model?.selection,
              );
            throw error;
          }),
        free: (winner, executionSignal) =>
          executeSelectedBuyerFree(
            input,
            context.dependencies,
            winner,
            executionSignal,
            onDelta,
          ),
        paid: async (winner, executionSignal) =>
          observeBuyerExecution(
            context.dependencies,
            winner,
            input,
            executionSignal,
            onDelta,
            async (emit) => {
              if (inferenceNeedsTools(input))
                throw new PaidBuyerError(PAID_BUYER_CODES.UNSUPPORTED);
              const runtime = await paid.get(executionSignal, input);
              const outcome = await executeSelectedBuyerPaid(
                input,
                runtime.paid,
                winner,
                executionSignal,
                emit,
              );
              if (!outcome) return undefined;
              const { result, error } = outcome.terminal;
              if (!result) throw new PaidOutcomeError(error.code, outcome);
              return { ...result, payment: paidSummary(outcome) };
            },
          ),
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
  const paid = lazyPaid(context, options, state, buyer);
  const { request } = context.prepared.config;
  return {
    execute: quoteExecutor(context, options, state, paid, buyer),
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
    inspect: paid.inspect,
    drain: paid.drain,
    close: paid.close,
  };
}
export function quoteBuyerExecution(options: Options): BuyerExecutionFactory {
  return (context) => startQuoteRuntime(context, options);
}
