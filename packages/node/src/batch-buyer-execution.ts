// Preflight and verified-use approval for one chosen seller; no selection, UI, retries or chain construction.
import { chargeV2 } from '@gyblos/core/pricing-v2';
import { recountSessionInput } from '@gyblos/core/session-input';
import { verifyInferenceUsage } from '@gyblos/inference/conversation';
import {
  BATCH_METHODS,
  batchFail,
  batchSessionRequest,
  buildBatchExecutionRequest,
  matchBatchTerms,
  verifyBatchQuote,
  type BatchChannelResult,
} from '@gyblos/protocol/batch-channel';
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

import { runBuyerBlocks } from './batch-block-buyer';
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
function verifiedCharge<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  quote: SignedOfferV2,
  input: FreeExecutionBuildInput,
  result: FreeExecutionResult,
) {
  let usage;
  try {
    usage = verifyInferenceUsage(input, result, context.options.meter);
  } catch {
    return batchFail(SESSION_CODES.UNVERIFIED);
  }
  const { inputTokens, outputTokens } = usage;
  return outputTokens
    ? String(
        chargeV2(
          { input: inputTokens, output: outputTokens },
          quote.offer.prices,
        ),
      )
    : '0';
}
async function openBuyerChannel<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  request: import('@gyblos/protocol/batch-channel').BatchExecutionRequest,
  signal: AbortSignal,
  payload: string,
) {
  const snapshot = batchBuyerSnapshot(
    await context.rpc(
      BATCH_METHODS.OPEN,
      { payload, quote: request.quote, terms: context.terms },
      signal,
    ),
    request.channelId,
  );
  if (snapshot.expiresAt !== context.terms.expiresAt)
    return batchFail(SESSION_CODES.BINDING);
  return snapshot;
}
export async function runBuyerBatch<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  value: SignedOfferV2,
  data: FreeExecutionBuildInput,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
) {
  const { options, terms, rpc, approve } = context;
  const quote = {
    offer: parseOfferV2(value.offer),
    signature: parseOfferSignatureV2(value.signature),
  };
  const { input } = recountSessionInput(quote, data, context.options.meter);
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
  const open = (payload: string) =>
    openBuyerChannel(context, request, signal, payload);
  if (context.blockMode) {
    await verify(signal);
    await open(await options.buyer.open());
    signal.throwIfAborted();
    return runBuyerBlocks(context, request, signal, onDelta);
  }
  return executeBatchBuyer(
    {
      buyer: options.buyer,
      verify,
      open,
      execute: async () => {
        const result = await rpc(
          BATCH_METHODS.EXECUTE,
          request,
          signal,
          onDelta,
        );
        if (!('bill' in result)) return batchFail();
        return result;
      },
      verifyUsage: async (result) =>
        verifiedCharge(context, quote, input, result),
      accept: approve,
    },
    await batchSessionRequest(request),
    signal,
  );
}
