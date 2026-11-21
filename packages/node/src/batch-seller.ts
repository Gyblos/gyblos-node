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
  type BatchExecutionRequest,
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
import type { RouteProbe } from '@gyblos/transport-iroh';
import type {
  BatchBlockExchange,
  BatchChannelService,
} from '@gyblos/transport-iroh/batch-server';

import { isBlockSeller } from './batch-block-ports';
import { createSellerBlockPlan } from './batch-block-seller';
import { batchLiveOffer, generateBatch } from './batch-generation';
import { publishSessionReceipt, sessionReceiptPayment } from './batch-receipts';
import { sellerExecutionTelemetry } from './free-telemetry';
import type { PaidSellerReceiptOptions } from './receipt-seller';
import type { LiveSellerOffer } from './seller-offer-set';

export interface SellerBatchSessionOptions {
  receipts?: (index: number) => PaidSellerReceiptOptions;
  blockTargetTokens?: number;
  telemetry?: import('./seller-sessions').SellerSessionOptions['telemetry'];
  session: SessionSeller;
  terms: Readonly<PaymentSessionTerms>;
  offers: () => readonly LiveSellerOffer[];
  now: () => number;
}
function batchObserver(
  request: BatchExecutionRequest,
  options: SellerBatchSessionOptions,
  live: LiveSellerOffer,
  streaming: boolean,
  route?: RouteProbe,
) {
  try {
    return sellerExecutionTelemetry(
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
      streaming,
      route,
    );
  } catch {
    /* Optional metadata cannot block generation. */
  }
}
async function executeObserved(
  request: BatchExecutionRequest,
  peer: string,
  signal: AbortSignal,
  options: SellerBatchSessionOptions,
  live: LiveSellerOffer,
  onDelta?: (text: string) => Promise<void>,
  blocks?: BatchBlockExchange,
  route?: RouteProbe,
) {
  const receivedAt = options.now();
  const started = performance.now();
  let first: number | null = null;
  const base = options.session.snapshot().cumulativeAtomic;
  const observer = batchObserver(
    request,
    options,
    live,
    Boolean(onDelta || blocks),
    route,
  );
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
    const pending = plan?.pending ?? (await batchSessionRequest(request));
    const result = await generateBatch(
      request,
      pending,
      plan?.session ?? options.session,
      peer,
      live,
      options.now,
      signal,
      plan || onDelta
        ? async (text, check) => {
            if (text) first ??= Math.floor(performance.now() - started);
            if (plan) await plan.delta(text, check);
            else await onDelta?.(text);
            if (text && !signal.aborted) observer?.firstToken();
          }
        : undefined,
      (duration) => observer?.generated(duration),
    );
    const completed = plan ? await plan.complete(result.value) : result;
    // Every paid session request is attested, with or without blocks: the bill is the same signed
    // recount either way, and its digest is the one both halves of the receipt bind.
    if (options.receipts) {
      try {
        publishSessionReceipt(
          options.receipts(live.index),
          request,
          pending.requestDigest,
          result.value,
          sessionReceiptPayment(request, options.terms, base, completed.bill),
          receivedAt,
          first,
          Math.floor(performance.now() - started),
        );
      } catch {
        /* Optional attestations never change the signed approval or repeat generation. */
      }
    }
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
  route?: RouteProbe,
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
      route,
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
    exchange: (request, peer, signal, onDelta, blocks, blockMode, route) =>
      run(peer, signal, () =>
        exchange(
          request,
          peer,
          signal,
          options,
          onDelta,
          blocks,
          blockMode,
          route,
        ),
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
