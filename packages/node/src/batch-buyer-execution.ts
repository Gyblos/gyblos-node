// Preflight and verified-use approval for one chosen seller; no selection, UI, retries or chain construction.
import { chargeV2 } from '@gyblos/core/pricing-v2';
import { recountSessionInput } from '@gyblos/core/session-input';
import { verifyInferenceUsage } from '@gyblos/inference/conversation';
import {
  BATCH_METHODS,
  batchExecutionDigest,
  batchFail,
  batchSessionRequest,
  buildBatchExecutionRequest,
  matchBatchTerms,
  verifyBatchQuote,
  type BatchChannelResult,
} from '@gyblos/protocol/batch-channel';
import { CONTROL_METERING_MODES } from '@gyblos/protocol/constants';
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
import { executeOpenedBatchBuyer } from './batch-buyer-opened';
import type { BuyerBatchContext } from './batch-buyer-types';
import {
  publishBuyerSessionReceipt,
  sessionReceiptPayment,
} from './batch-receipts';
import { verifyDecline } from './buyer-declined-request';
import { recoverBuyerOpening } from './buyer-opening-retry';
import { bounded } from './buyer-operation';
import { declaredCharge, verifyDeclaredUsage } from './declared-usage';

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
    usage =
      quote.offer.meteringMode === CONTROL_METERING_MODES.DECLARED
        ? verifyDeclaredUsage(input, result)
        : verifyInferenceUsage(input, result, context.options.meter);
  } catch {
    return batchFail(SESSION_CODES.UNVERIFIED);
  }
  const { inputTokens, outputTokens } = usage;
  if (
    outputTokens &&
    quote.offer.meteringMode === CONTROL_METERING_MODES.DECLARED
  )
    return declaredCharge(usage, quote.offer);
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
function verifyOpeningTime(
  quote: SignedOfferV2,
  expiresAt: number,
  now: number,
) {
  validateOfferV2Time(quote.offer, now);
  if (now >= expiresAt) return batchFail(SESSION_CODES.LIMIT);
}
export async function runBuyerBatch<Remote extends BatchDestination>(
  channel: BuyerBatchContext<Remote>,
  value: SignedOfferV2,
  data: FreeExecutionBuildInput,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
) {
  const quote = {
    offer: parseOfferV2(value.offer),
    signature: parseOfferSignatureV2(value.signature),
  };
  // Blocks certify prefixes with the model's tokenizer; a declared offer has none, so it runs whole, over
  // the whole-response protocol even on a channel that checkpoints other requests.
  const declared = quote.offer.meteringMode === CONTROL_METERING_MODES.DECLARED;
  const context = declared ? channel.wholeResponse() : channel;
  const { options, terms, rpc, blockMode } = context;
  if (blockMode && typeof options.meter.stablePrefix !== 'function')
    return batchFail(PAID_EXECUTION_CODES.UNSUPPORTED);
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
    verifyOpeningTime(quote, terms.expiresAt, options.now());
    current.throwIfAborted();
  };
  await verify(signal);
  if (!options.preparation?.consume(quote, terms, blockMode)) {
    const prepared = await rpc(BATCH_METHODS.PREPARE, { quote, terms }, signal);
    if (!('terms' in prepared)) return batchFail(SESSION_CODES.BINDING);
    matchBatchTerms(prepared.terms, terms);
  }
  await verify(signal);
  const { request, started } = await recoverBuyerOpening(
    options.buyer,
    async () => {
      signal.throwIfAborted();
      const payload = await options.buyer.open(() => {
        signal.throwIfAborted();
        verifyOpeningTime(quote, terms.expiresAt, options.now());
      });
      const channelId = options.buyer.snapshot().channelId;
      const prepared = buildBatchExecutionRequest(channelId, quote, input);
      const started = performance.now();
      await verify(signal);
      return async () => {
        await openBuyerChannel(context, prepared, signal, payload);
        return { request: prepared, started };
      };
    },
    verify,
    signal,
    options.financialPermission,
  );
  await verify(signal);
  await options.beforeInference?.(
    request.requestId,
    {
      requestId: request.requestId,
      channelId: request.channelId,
      sellerNodeId: terms.sellerNodeId,
      baseAtomic: options.buyer.snapshot().cumulativeAtomic,
    },
    await batchExecutionDigest(request),
  );
  signal.throwIfAborted();
  if (blockMode) return runBuyerBlocks(context, request, signal, onDelta);
  return runBuyerSession(context, request, {
    started,
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
    started: number;
    verifyUsage: (result: FreeExecutionResult) => Promise<string>;
    signal: AbortSignal;
    onDelta?: (text: string) => Promise<void>;
  },
) {
  const { options, terms, rpc, approve } = context;
  const { signal, onDelta, started } = steps;
  const pending = await batchSessionRequest(request);
  let first: number | null = null;
  let billed: SessionBill | undefined;
  const baseAtomic = options.buyer.snapshot().cumulativeAtomic;
  const generated = await executeOpenedBatchBuyer(
    {
      buyer: options.buyer,
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
