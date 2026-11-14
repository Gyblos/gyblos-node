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
import type {
  BatchBlockExchange,
  BatchChannelService,
} from '@gyblos/transport-iroh/batch-server';

import { batchLiveOffer } from './batch-generation';
import { createSellerBatchSession } from './batch-seller';
import type { LiveSellerOffer } from './seller-offer-set';
import type { SellerSessionBackend } from './session-backend';

export interface SellerSessionOptions {
  telemetry?: {
    sink: import('@gyblos/protocol/telemetry').TelemetrySink;
    engineKind: (
      index: number,
    ) => import('@gyblos/protocol/constants').EngineKind;
    now?: () => number;
  };
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
      telemetry: options.telemetry,
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
  blocks?: BatchBlockExchange,
  blockMode?: boolean,
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
    const live = batchLiveOffer(offer, options.offers(), options.now());
    if (blockMode && !live.meter.stablePrefix)
      return batchFail(SESSION_CODES.UNAVAILABLE);
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
  return state.current.service.exchange(
    request,
    peer,
    signal,
    onDelta,
    blocks,
    blockMode,
  );
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
  const run = async <T>(
    peer: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ) => {
    if (closed) return batchFail(SESSION_CODES.UNAVAILABLE);
    if (peer !== options.buyerNodeId)
      return batchFail(PAID_EXECUTION_CODES.PEER);
    if (active) return batchFail(SESSION_CODES.BUSY);
    signal.throwIfAborted();
    const running = operation();
    active = running;
    try {
      return await running;
    } catch (error) {
      if (signal.aborted) return batchFail(PAID_EXECUTION_CODES.CANCELLED);
      throw batchError(error);
    } finally {
      active = undefined;
    }
  };
  return {
    service: {
      exchange: (request, peer, signal, onDelta, blocks, blockMode) =>
        run(peer, signal, () =>
          operation(
            options,
            state,
            request,
            peer,
            signal,
            onDelta,
            blocks,
            blockMode,
          ),
        ),
      resumeBlock: (approval, peer, signal) =>
        run(peer, signal, () => {
          if (!state.current?.service.resumeBlock)
            return batchFail(SESSION_CODES.UNAVAILABLE);
          return state.current.service.resumeBlock(approval, peer, signal);
        }),
    },
    async close() {
      closed = true;
      await active?.catch(() => {});
      await state.current?.session.dispose();
    },
  };
}
