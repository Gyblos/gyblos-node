// Seller host for one explicitly provisioned buyer/session; authenticated Iroh never supplies chain truth.
import { completeInferenceTelemetry } from '@gyblos/inference/observation';
import {
  BATCH_METHODS,
  BatchChannelError,
  batchError,
  batchFail,
  batchSessionRequest,
  matchBatchTerms,
  verifyBatchQuote,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  type PaymentSessionTerms,
  type SessionSeller,
} from '@gyblos/protocol/payment-session';
import {
  SESSION_BLOCK_KINDS,
  type SessionBlockAck,
} from '@gyblos/protocol/session-blocks';
import type {
  BatchBlockExchange,
  BatchChannelService,
} from '@gyblos/transport-iroh/batch-server';

import { isBlockSeller } from './batch-block-ports';
import { createSellerBlockPlan } from './batch-block-seller';
import { batchLiveOffer, generateBatch } from './batch-generation';
import { sellerExecutionTelemetry } from './free-telemetry';
import type { LiveSellerOffer } from './seller-offer-set';

export interface SellerBatchSessionOptions {
  blockTargetTokens?: number;
  telemetry?: import('./seller-sessions').SellerSessionOptions['telemetry'];
  session: SessionSeller;
  terms: Readonly<PaymentSessionTerms>;
  offers: () => readonly LiveSellerOffer[];
  now: () => number;
}
async function executeObserved(
  request: import('@gyblos/protocol/batch-channel').BatchExecutionRequest,
  peer: string,
  signal: AbortSignal,
  options: SellerBatchSessionOptions,
  live: LiveSellerOffer,
  onDelta?: (text: string) => Promise<void>,
  blocks?: BatchBlockExchange,
) {
  let observer: ReturnType<typeof sellerExecutionTelemetry>;
  try {
    observer = sellerExecutionTelemetry(
      request,
      {
        telemetry: options.telemetry
          ? {
              ...options.telemetry,
              engineKind: options.telemetry.engineKind(live.index),
            }
          : undefined,
        nodeId: options.terms.sellerNodeId,
        meter: live.meter,
      },
      Boolean(onDelta || blocks),
    );
  } catch {
    /* Optional metadata cannot block generation. */
  }

  let plan: Awaited<ReturnType<typeof createSellerBlockPlan>> | undefined;
  try {
    plan = blocks
      ? await createSellerBlockPlan(
          request,
          options,
          live,
          peer,
          signal,
          blocks,
        )
      : undefined;
    const result = await generateBatch(
      request,
      plan?.pending ?? (await batchSessionRequest(request)),
      plan?.session ?? options.session,
      peer,
      live,
      options.now,
      signal,
      plan || onDelta
        ? async (text, check) => {
            if (plan) await plan.delta(text, check);
            else await onDelta?.(text);
            if (text && !signal.aborted) observer?.firstToken();
          }
        : undefined,
      (duration) => observer?.generated(duration),
    );
    const completed = plan ? await plan.complete(result.value) : result;
    completeInferenceTelemetry(observer, request.input, result.value);
    return completed;
  } catch (error) {
    observer?.failed(
      signal.aborted
        ? FREE_EXECUTION_CODES.CANCELLED
        : FREE_EXECUTION_CODES.ENGINE,
    );
    throw error;
  } finally {
    await plan?.release();
  }
}
async function exchange(
  request: BatchChannelRequest,
  peer: string,
  signal: AbortSignal,
  options: SellerBatchSessionOptions,
  onDelta?: (text: string) => Promise<void>,
  blocks?: BatchBlockExchange,
  blockMode?: boolean,
) {
  signal.throwIfAborted();
  const session = options.session;
  if (
    request.method === BATCH_METHODS.PREPARE ||
    request.method === BATCH_METHODS.OPEN ||
    request.method === BATCH_METHODS.EXECUTE
  ) {
    const quote = request.params.quote;
    if ('terms' in request.params && request.params.terms)
      matchBatchTerms(request.params.terms, options.terms);
    const offer = await verifyBatchQuote(
      quote,
      options.terms,
      peer,
      options.now(),
    );
    signal.throwIfAborted();
    if (request.method === BATCH_METHODS.PREPARE) {
      try {
        const checkedAt = options.now();
        validateOfferV2Time(offer, checkedAt);
        if (checkedAt >= options.terms.expiresAt)
          return batchFail(SESSION_CODES.LIMIT);
      } catch (error) {
        throw batchError(error);
      }
    }
    const live = batchLiveOffer(offer, options.offers(), options.now());
    if (
      (blockMode || blocks) &&
      (!live.meter.stablePrefix || !isBlockSeller(session))
    )
      return batchFail(SESSION_CODES.UNAVAILABLE);
    if (request.method === BATCH_METHODS.PREPARE)
      return { terms: structuredClone(options.terms) };
    if (request.method === BATCH_METHODS.OPEN)
      return { snapshot: await session.open(request.params.payload) };
    if (request.params.channelId !== session.snapshot().channelId)
      return batchFail(SESSION_CODES.BINDING);
    return executeObserved(
      request.params,
      peer,
      signal,
      options,
      live,
      onDelta,
      blocks,
    );
  }
  const channel =
    request.method === BATCH_METHODS.APPROVE
      ? request.params.voucher.channelId
      : request.params.channelId;
  if (channel !== session.snapshot().channelId)
    return batchFail(SESSION_CODES.BINDING);
  if (request.method === BATCH_METHODS.APPROVE) {
    await session.accept(request.params.bill, request.params.voucher, peer);
    return { snapshot: session.snapshot() };
  }
  if (request.method === BATCH_METHODS.CLOSE)
    return { settlement: await session.close() };
  return { snapshot: session.snapshot() };
}
export function createSellerBatchSession(
  input: SellerBatchSessionOptions,
): BatchChannelService {
  const options = {
    ...input,
    terms: matchBatchTerms(input.terms, input.terms),
  };
  let active = false;
  const run = async <T>(
    peer: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ) => {
    if (peer !== options.terms.buyerNodeId)
      throw new BatchChannelError(PAID_EXECUTION_CODES.PEER);
    signal.throwIfAborted();
    if (active) return batchFail(SESSION_CODES.BUSY);
    active = true;
    try {
      return await operation();
    } finally {
      active = false;
    }
  };
  return {
    exchange: (request, peer, signal, onDelta, blocks, blockMode) =>
      run(peer, signal, () =>
        exchange(request, peer, signal, options, onDelta, blocks, blockMode),
      ),
    resumeBlock: (approval, peer, signal) =>
      run(peer, signal, async (): Promise<SessionBlockAck> => {
        const session = options.session;
        if (!isBlockSeller(session))
          return batchFail(SESSION_CODES.UNAVAILABLE);
        const intent = await session.resumeBlock(approval, peer);
        signal.throwIfAborted();
        return {
          version: approval.version,
          kind: SESSION_BLOCK_KINDS.ACK,
          channelId: approval.channelId,
          requestId: approval.requestId,
          requestDigest: approval.requestDigest,
          index: approval.index,
          blockDigest: intent.digest,
          cumulativeAtomic: intent.bill.cumulativeAtomic,
        };
      }),
  };
}
