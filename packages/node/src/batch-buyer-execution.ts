// Preflight and verified-use approval for one chosen seller; no selection, UI, retries or chain construction.
import { INFERENCE_REQUEST_LIMITS } from '@gyblos/config';
import { paidPrompt } from '@gyblos/core/buyer-paid-recount';
import { chargeV2 } from '@gyblos/core/pricing-v2';
import {
  BATCH_METHODS,
  batchExecutionInput,
  batchFail,
  batchSessionRequest,
  buildBatchExecutionRequest,
  matchBatchTerms,
  verifyBatchQuote,
  type BatchChannelResult,
} from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { SignedOfferV2 } from '@gyblos/protocol/control-types';
import type {
  FreeExecutionBuildInput,
  FreeExecutionResult,
} from '@gyblos/protocol/free-execution';
import {
  parseOfferSignatureV2,
  parseOfferV2,
  validateOfferV2Time,
} from '@gyblos/protocol/offer-v2';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import type { BatchDestination } from '@gyblos/transport-iroh/batch-client';

import type { BuyerBatchContext } from './batch-buyer-types';
import { executeBatchBuyer } from './batch-session';
import { bounded } from './buyer-operation';

export function batchBuyerSnapshot(
  result: BatchChannelResult,
  channelId: string,
) {
  if (!('snapshot' in result) || result.snapshot.channelId !== channelId)
    return batchFail(SESSION_CODES.BINDING);
  return result.snapshot;
}
function buyerInput<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  quote: SignedOfferV2,
  data: FreeExecutionBuildInput,
) {
  const input = batchExecutionInput(quote, data);
  const prompt = paidPrompt(input, context.options.meter);
  if (
    prompt === undefined ||
    quote.offer.reasoning !== REASONING_LEVELS.OFF ||
    quote.offer.meteringMode !== CONTROL_METERING_MODES.RECOUNTED
  )
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
  const count = context.options.meter.input(prompt);
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    input.maxTokens > INFERENCE_REQUEST_LIMITS.maxOutputTokens ||
    count + input.maxTokens > quote.offer.model.contextTokens
  )
    return batchFail(PAID_EXECUTION_CODES.LIMIT);
  if (
    chargeV2({ input: count, output: input.maxTokens }, quote.offer.prices) >
    BigInt(quote.offer.maxAtomic)
  )
    return batchFail(PAID_EXECUTION_CODES.BUDGET_EXHAUSTED);
  return { input, prompt };
}
function verifiedCharge<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  quote: SignedOfferV2,
  prompt: string,
  maxTokens: number,
  result: FreeExecutionResult,
) {
  const inputTokens = context.options.meter.input(prompt);
  const outputTokens = result.text
    ? context.options.meter.count(result.text)
    : 0;
  if (
    inputTokens !== result.usage.inputTokens ||
    outputTokens !== result.usage.outputTokens ||
    outputTokens > maxTokens
  )
    return batchFail(SESSION_CODES.UNVERIFIED);
  return outputTokens
    ? String(
        chargeV2(
          { input: inputTokens, output: outputTokens },
          quote.offer.prices,
        ),
      )
    : '0';
}
export async function runBuyerBatch<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  value: SignedOfferV2,
  data: FreeExecutionBuildInput,
  signal: AbortSignal,
) {
  const { options, terms, rpc, approve } = context;
  const quote = {
    offer: parseOfferV2(value.offer),
    signature: parseOfferSignatureV2(value.signature),
  };
  const { input, prompt } = buyerInput(context, quote, data);
  const verify = async (current: AbortSignal) => {
    current.throwIfAborted();
    if (await bounded(options.unresolved(), current))
      return batchFail(SESSION_CODES.UNVERIFIED);
    await bounded(options.verify(quote, current), current);
    await verifyBatchQuote(
      quote,
      terms,
      options.endpoint.id().toString(),
      options.now(),
    );
    const checkedAt = options.now();
    validateOfferV2Time(quote.offer, checkedAt);
    if (checkedAt >= terms.expiresAt) return batchFail(SESSION_CODES.LIMIT);
    current.throwIfAborted();
  };
  await verify(signal);
  const prepared = await rpc(BATCH_METHODS.PREPARE, { quote, terms }, signal);
  if (!('terms' in prepared)) return batchFail(SESSION_CODES.BINDING);
  matchBatchTerms(prepared.terms, terms);
  await verify(signal);
  signal.throwIfAborted();
  await bounded(
    options.buyer.open(() => {
      signal.throwIfAborted();
      validateOfferV2Time(quote.offer, options.now());
      if (options.now() >= terms.expiresAt)
        return batchFail(SESSION_CODES.LIMIT);
    }),
    signal,
  );
  signal.throwIfAborted();
  const channelId = options.buyer.snapshot().channelId;
  const request = buildBatchExecutionRequest(channelId, quote, input);
  return executeBatchBuyer(
    {
      buyer: options.buyer,
      verify,
      open: async (payload) => {
        const snapshot = batchBuyerSnapshot(
          await rpc(BATCH_METHODS.OPEN, { payload, quote, terms }, signal),
          channelId,
        );
        if (snapshot.expiresAt !== terms.expiresAt)
          return batchFail(SESSION_CODES.BINDING);
        return snapshot;
      },
      execute: async () => {
        const result = await rpc(BATCH_METHODS.EXECUTE, request, signal);
        if (!('bill' in result)) return batchFail();
        return result;
      },
      verifyUsage: async (result) =>
        verifiedCharge(context, quote, prompt, input.maxTokens, result),
      accept: approve,
    },
    await batchSessionRequest(request),
    signal,
  );
}
