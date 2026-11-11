// Owns one explicitly permitted buyer session for the daemon, independently of Iroh connections.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_METHODS,
  batchError,
  batchFail,
  matchBatchTerms,
  verifyBatchQuote,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import type { PaymentDescription } from '@gyblos/protocol/payment';
import {
  SESSION_CODES,
  type PaymentSessionTerms,
  type SessionSeller,
} from '@gyblos/protocol/payment-session';
import type { BatchChannelService } from '@gyblos/transport-iroh/batch-server';

import { batchLiveOffer } from './batch-generation';
import { createSellerBatchSession } from './batch-seller';
import type { LiveSellerOffer } from './seller-offer-set';
import type { SellerSessionBackend } from './session-backend';

export interface SellerSessionOptions {
  buyerNodeId: string;
  backend: SellerSessionBackend;
  description: PaymentDescription;
  owner: string;
  nodeId: string;
  offers: () => readonly LiveSellerOffer[];
  now: () => number;
}
export interface SellerSessionHost {
  service: BatchChannelService;
  close(): Promise<void>;
}
interface Binding {
  terms: PaymentSessionTerms;
  session: SessionSeller;
  service: BatchChannelService;
}
function ownTerms(
  input: PaymentSessionTerms,
  options: SellerSessionOptions,
  fresh: boolean,
) {
  const own = options.description;
  const terms = matchBatchTerms(input, {
    ...input,
    owner: options.owner,
    sellerNodeId: options.nodeId,
    buyerNodeId: options.buyerNodeId,
    network: own.network,
    mint: own.mint,
    payTo: own.payTo,
    feePayer: own.feePayer,
    authorizer: own.authorizer,
    treasury: own.treasury,
    protocolFeeBps: own.protocolFeeBps,
  });
  if (
    BigInt(terms.depositAtomic) >
      BigInt(BATCH_SESSION_DEFAULTS.maxDepositAtomic) ||
    terms.withdrawDelaySeconds < BATCH_SESSION_DEFAULTS.withdrawDelaySeconds ||
    terms.withdrawDelaySeconds >
      BATCH_SESSION_DEFAULTS.maxWithdrawDelaySeconds ||
    (fresh &&
      (terms.expiresAt <= options.now() ||
        terms.expiresAt > options.now() + BATCH_SESSION_DEFAULTS.maxLifetimeMs))
  )
    return batchFail(SESSION_CODES.LIMIT);
  return terms;
}
function binding(
  options: SellerSessionOptions,
  terms: PaymentSessionTerms,
  session: SessionSeller,
): Binding {
  return {
    terms,
    session,
    service: createSellerBatchSession({
      session,
      terms,
      now: options.now,
      offers: options.offers,
    }),
  };
}
async function operation(
  options: SellerSessionOptions,
  state: { current?: Binding },
  request: BatchChannelRequest,
  peer: string,
  signal: AbortSignal,
  onDelta?: (text: string) => Promise<void>,
) {
  signal.throwIfAborted();
  if (
    request.method === BATCH_METHODS.PREPARE ||
    request.method === BATCH_METHODS.OPEN
  ) {
    const proposed = request.params.terms ?? state.current?.terms;
    if (!proposed) return batchFail();
    const terms = ownTerms(proposed, options, !state.current);
    if (
      state.current &&
      canonicalJson(state.current.terms) !== canonicalJson(terms)
    )
      return batchFail(SESSION_CODES.BUSY);
    const offer = await verifyBatchQuote(
      request.params.quote,
      terms,
      peer,
      options.now(),
    );
    signal.throwIfAborted();
    const checkedAt = options.now();
    validateOfferV2Time(offer, checkedAt);
    if (checkedAt >= terms.expiresAt) return batchFail(SESSION_CODES.LIMIT);
    batchLiveOffer(offer, options.offers(), options.now());
    if (request.method === BATCH_METHODS.PREPARE) return { terms };
    if (!state.current) {
      const session = await options.backend.create(
        terms,
        request.params.payload,
      );
      if (signal.aborted) {
        await session.dispose();
        signal.throwIfAborted();
      }
      state.current = binding(options, terms, session);
    }
  }
  if (!state.current) return batchFail(SESSION_CODES.UNAVAILABLE);
  return state.current.service.exchange(request, peer, signal, onDelta);
}
export async function startSellerSessions(
  options: SellerSessionOptions,
): Promise<SellerSessionHost> {
  const state: { current?: Binding } = {};
  const stored = await options.backend.inspect();
  if (stored) {
    const terms = ownTerms(stored.terms, options, false);
    state.current = binding(
      options,
      terms,
      await options.backend.create(terms),
    );
  }
  let active: Promise<unknown> | undefined;
  let closed = false;
  return {
    service: {
      async exchange(request, peer, signal, onDelta) {
        if (closed) return batchFail(SESSION_CODES.UNAVAILABLE);
        if (peer !== options.buyerNodeId)
          return batchFail(PAID_EXECUTION_CODES.PEER);
        if (active) return batchFail(SESSION_CODES.BUSY);
        const running = operation(
          options,
          state,
          request,
          peer,
          signal,
          onDelta,
        );
        active = running;
        try {
          return await running;
        } catch (error) {
          if (signal.aborted) return batchFail(PAID_EXECUTION_CODES.CANCELLED);
          throw batchError(error);
        } finally {
          active = undefined;
        }
      },
    },
    async close() {
      closed = true;
      await active?.catch(() => {});
      await state.current?.session.dispose();
    },
  };
}
