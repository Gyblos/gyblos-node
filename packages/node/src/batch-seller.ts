// Seller host for one explicitly provisioned buyer/session; authenticated Iroh never supplies chain truth.
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
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  type PaymentSessionTerms,
  type SessionSeller,
} from '@gyblos/protocol/payment-session';
import type { BatchChannelService } from '@gyblos/transport-iroh/batch-server';

import { batchLiveOffer, generateBatch } from './batch-generation';
import type { LiveSellerOffer } from './seller-offer-set';

export interface SellerBatchSessionOptions {
  session: SessionSeller;
  terms: Readonly<PaymentSessionTerms>;
  offers: () => readonly LiveSellerOffer[];
  now: () => number;
}
async function exchange(
  request: BatchChannelRequest,
  peer: string,
  signal: AbortSignal,
  options: SellerBatchSessionOptions,
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
    if (request.method === BATCH_METHODS.PREPARE)
      return { terms: structuredClone(options.terms) };
    if (request.method === BATCH_METHODS.OPEN)
      return { snapshot: await session.open(request.params.payload) };
    if (request.params.channelId !== session.snapshot().channelId)
      return batchFail(SESSION_CODES.BINDING);
    return generateBatch(
      request.params,
      await batchSessionRequest(request.params),
      session,
      peer,
      live,
      options.now,
      signal,
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
  return {
    async exchange(request, peer, signal) {
      if (peer !== options.terms.buyerNodeId)
        throw new BatchChannelError(PAID_EXECUTION_CODES.PEER);
      if (active) return batchFail(SESSION_CODES.BUSY);
      active = true;
      try {
        return await exchange(request, peer, signal, options);
      } finally {
        active = false;
      }
    },
  };
}
