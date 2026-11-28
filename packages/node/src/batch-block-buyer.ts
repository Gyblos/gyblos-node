// Incremental verification uses the shared inference pipeline; approval is durable before transport sends it.
import { createHash } from 'node:crypto';

import { chargeV2 } from '@gyblos/core/pricing-v2';
import {
  verifyInferencePrefix,
  verifyInferenceUsage,
} from '@gyblos/inference/conversation';
import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_METHODS,
  batchFail,
  type BatchExecutionRequest,
} from '@gyblos/protocol/batch-channel';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
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
import {
  publishBuyerSessionReceipt,
  sessionReceiptPayment,
} from './batch-receipts';
import { verifyDecline } from './buyer-declined-request';
import { bounded } from './buyer-operation';

function blockCallbacks<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  request: BatchExecutionRequest,
  pending: SessionRequest,
  buyer: SessionBlockBuyer,
  baseAtomic: string,
  check: () => void,
): BatchBlockClient & { hasAcknowledgedPrefix(): boolean } {
  const { options } = context;
  let partial = false;
  return {
    hasAcknowledgedPrefix: () => partial,
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
    approve: (intent, transportCheck) => {
      partial = false;
      return buyer.approveBlock(intent, intent.bill.chargedAtomic, () => {
        check();
        transportCheck();
      });
    },
    acknowledge: async (intent) => {
      await buyer.acknowledgeBlock(intent);
      partial = !intent.terminal;
    },
  };
}
export function buyerQuestionDigest(
  messages: FreeExecutionBuildInput['messages'],
  keyId: string | undefined,
) {
  return createHash('sha256')
    .update(
      canonicalJson([
        keyId ?? null,
        messages
          .filter((message) => message.role === FREE_CHAT_ROLES.USER)
          .map((message) => message.content),
      ]),
    )
    .digest('hex');
}
export async function runBuyerBlocks<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  request: BatchExecutionRequest,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
) {
  const { options, terms } = context;
  const started = performance.now();
  let first: number | null = null;
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
  await bounded(
    buyer.beginBlocks(
      pending,
      buyerQuestionDigest(
        request.input.messages,
        options.credentialId?.(request.requestId),
      ),
    ),
    signal,
  );
  check();
  const callbacks = blockCallbacks(
    context,
    request,
    pending,
    buyer,
    baseAtomic,
    check,
  );
  const result = await context
    .rpc(
      BATCH_METHODS.EXECUTE,
      request,
      signal,
      async (text) => {
        if (text) first ??= Math.floor(performance.now() - started);
        await onDelta?.(text);
      },
      callbacks,
    )
    .catch(async (error: unknown) => {
      if (options.settleInterrupted && callbacks.hasAcknowledgedPrefix()) {
        await context.closeInterrupted();
        throw error;
      }
      return verifyDecline(context, pending, request.channelId, signal, error);
    });
  check();
  if (
    !('bill' in result) ||
    buyer.snapshot().reservedAtomic !== '0' ||
    buyer.snapshot().cumulativeAtomic !== result.bill.cumulativeAtomic
  )
    return batchFail(SESSION_CODES.BINDING);
  publishBuyerSessionReceipt(
    options.receipt,
    request,
    pending.requestDigest,
    result.value,
    () => sessionReceiptPayment(request, terms, baseAtomic, result.bill),
    first,
    Math.floor(performance.now() - started),
  );
  return result.value;
}
