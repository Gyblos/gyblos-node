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
import {
  SESSION_CODES,
  type SessionBill,
} from '@gyblos/protocol/payment-session';
import type { BatchDestination } from '@gyblos/transport-iroh/batch-client';

import { runBuyerBlocks } from './batch-block-buyer';
import type { BuyerBatchContext } from './batch-buyer-types';
import {
  publishBuyerSessionReceipt,
  sessionReceiptPayment,
} from './batch-receipts';
import { executeBatchBuyer } from './batch-session';
import { verifyDecline } from './buyer-declined-request';
import { recoverBuyerOpening } from './buyer-opening-retry';
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
  if (context.blockMode && typeof options.meter.stablePrefix !== 'function')
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
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
  if (!options.preparation?.consume(quote, terms, context.blockMode)) {
    const prepared = await rpc(BATCH_METHODS.PREPARE, { quote, terms }, signal);
    if (!('terms' in prepared)) return batchFail(SESSION_CODES.BINDING);
    matchBatchTerms(prepared.terms, terms);
  }
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
    openVerified(context, request, verify, signal, payload);
  if (context.blockMode) {
    await verify(signal);
    await open(await options.buyer.open());
    signal.throwIfAborted();
    return runBuyerBlocks(context, request, signal, onDelta);
  }
  return runBuyerSession(context, request, {
    verify,
    open,
    verifyUsage: async (result) =>
      verifiedCharge(context, quote, input, result),
    signal,
    onDelta,
  });
}

// One paid session request without blocks: execute, verify, approve, then attest it like a block
// request (same evidence, same digest as the seller's half).
async function runBuyerSession<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  request: import('@gyblos/protocol/batch-channel').BatchExecutionRequest,
  steps: {
    verify: (signal: AbortSignal) => Promise<void>;
    open: (
      payload: string,
    ) => Promise<import('@gyblos/protocol/payment-session').SessionSnapshot>;
    verifyUsage: (result: FreeExecutionResult) => Promise<string>;
    signal: AbortSignal;
    onDelta?: (text: string) => Promise<void>;
  },
) {
  const { options, terms, rpc, approve } = context;
  const { signal, onDelta } = steps;
  const pending = await batchSessionRequest(request);
  const started = performance.now();
  let first: number | null = null;
  let billed: SessionBill | undefined;
  const baseAtomic = options.buyer.snapshot().cumulativeAtomic;
  const generated = await executeBatchBuyer(
    {
      buyer: options.buyer,
      verify: steps.verify,
      open: steps.open,
      execute: async () => {
        const result = await rpc(
          BATCH_METHODS.EXECUTE,
          request,
          signal,
          async (text) => {
            if (text) first ??= Math.floor(performance.now() - started);
            await onDelta?.(text);
          },
        ).catch((error: unknown) =>
          verifyDecline(context, pending, request.channelId, signal, error),
        );
        if (!('bill' in result)) return batchFail();
        billed = result.bill;
        return result;
      },
      verifyUsage: steps.verifyUsage,
      accept: approve,
    },
    pending,
    signal,
  );
  const bill = billed;
  if (bill)
    publishBuyerSessionReceipt(
      options.receipt,
      request,
      pending.requestDigest,
      generated,
      () => sessionReceiptPayment(request, terms, baseAtomic, bill),
      first,
      Math.floor(performance.now() - started),
    );
  return generated;
}

async function openVerified<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  request: Parameters<typeof openBuyerChannel>[1],
  verify: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  payload: string,
) {
  const { options, terms } = context;
  const channelId = request.channelId;

  const snapshot = await recoverBuyerOpening(
    options.buyer,
    () => {
      const send = () => openBuyerChannel(context, request, signal, payload);
      return options.financialPermission
        ? options.financialPermission(send)
        : send();
    },
    verify,
    signal,
  );
  await options.beforeInference?.(request.requestId, {
    requestId: request.requestId,
    channelId,
    sellerNodeId: terms.sellerNodeId,
    baseAtomic: options.buyer.snapshot().cumulativeAtomic,
  });
  signal.throwIfAborted();
  return snapshot;
}
