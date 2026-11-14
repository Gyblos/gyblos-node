// Incremental verification uses the shared inference pipeline; approval is durable before transport sends it.
import { chargeV2 } from '@gyblos/core/pricing-v2';
import {
  verifyInferencePrefix,
  verifyInferenceUsage,
} from '@gyblos/inference/conversation';
import {
  BATCH_METHODS,
  batchFail,
  type BatchExecutionRequest,
} from '@gyblos/protocol/batch-channel';
import {
  SESSION_CODES,
  type SessionRequest,
} from '@gyblos/protocol/payment-session';
import {
  sessionBlockRequestDigest,
  type SessionBlockBuyer,
} from '@gyblos/protocol/session-blocks';
import type {
  BatchBlockClient,
  BatchDestination,
} from '@gyblos/transport-iroh/batch-client';

import { isBlockBuyer } from './batch-block-ports';
import type { BuyerBatchContext } from './batch-buyer-types';
import { bounded } from './buyer-operation';

function blockCallbacks<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  request: BatchExecutionRequest,
  pending: SessionRequest,
  buyer: SessionBlockBuyer,
  baseAtomic: string,
  check: () => void,
): BatchBlockClient {
  const { options } = context;
  return {
    verification: {
      binding: {
        channelId: request.channelId,
        requestId: pending.requestId,
        requestDigest: pending.requestDigest,
      },
      request: pending,
      baseAtomic,
      depositAtomic: options.terms.depositAtomic,
      maxTokens: request.input.maxTokens,
      async verify(text, terminal) {
        check();
        let usage;
        try {
          usage = terminal
            ? verifyInferenceUsage(request.input, terminal, options.meter)
            : verifyInferencePrefix(request.input, text, options.meter);
        } catch {
          return batchFail(SESSION_CODES.UNVERIFIED);
        }
        if (
          usage.inputTokens + usage.outputTokens >
          request.quote.offer.model.contextTokens
        )
          return batchFail(SESSION_CODES.LIMIT);
        return {
          ...usage,
          chargedAtomic: usage.outputTokens
            ? String(
                chargeV2(
                  { input: usage.inputTokens, output: usage.outputTokens },
                  request.quote.offer.prices,
                ),
              )
            : '0',
        };
      },
    },
    approve: (intent, transportCheck) =>
      buyer.approveBlock(intent, intent.bill.chargedAtomic, () => {
        check();
        transportCheck();
      }),
    acknowledge: (intent) => buyer.acknowledgeBlock(intent),
  };
}
export async function runBuyerBlocks<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  request: BatchExecutionRequest,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
) {
  const { options, terms } = context;
  const buyer = options.buyer;
  if (!isBlockBuyer(buyer)) return batchFail(SESSION_CODES.UNAVAILABLE);
  const pending = {
    requestId: request.requestId,
    requestDigest: await sessionBlockRequestDigest(request),
    maxAtomic: request.quote.offer.maxAtomic,
  };
  const baseAtomic = buyer.snapshot().cumulativeAtomic;
  const check = () => {
    signal.throwIfAborted();
    if (options.now() >= terms.expiresAt)
      return batchFail(SESSION_CODES.CLOSED);
  };
  check();
  await bounded(buyer.beginBlocks(pending), signal);
  check();
  const callbacks = blockCallbacks(
    context,
    request,
    pending,
    buyer,
    baseAtomic,
    check,
  );
  const result = await context.rpc(
    BATCH_METHODS.EXECUTE,
    request,
    signal,
    onDelta,
    callbacks,
  );
  check();
  if (
    !('bill' in result) ||
    buyer.snapshot().reservedAtomic !== '0' ||
    buyer.snapshot().cumulativeAtomic !== result.bill.cumulativeAtomic
  )
    return batchFail(SESSION_CODES.BINDING);
  return result.value;
}
