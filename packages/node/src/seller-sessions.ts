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
  SESSION_STATES,
  type PaymentSessionTerms,
  type SessionSeller,
} from '@gyblos/protocol/payment-session';
import type {
  BatchBlockExchange,
  BatchChannelService,
} from '@gyblos/transport-iroh/batch-server';

import { batchLiveOffer } from './batch-generation';
import { createSellerBatchSession } from './batch-seller';
import { SELLER_CHANNEL_DIAGNOSTICS } from './constants';
import {
  sellerChannelDiagnostics,
  type SellerChannelOperation,
} from './seller-channel-diagnostics';
import type { LiveSellerOffer } from './seller-offer-set';
import type { SellerSessionBackend } from './session-backend';

export interface SellerSessionOptions {
  admit?: () => Promise<void>;
  receipts?: import('./batch-seller').SellerBatchSessionOptions['receipts'];
  diagnostics?: import('@gyblos/runtime/diagnostics').DiagnosticSink;
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
  ownsSession?: () => boolean;
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
      (BigInt(terms.depositAtomic) <
        BigInt(BATCH_SESSION_DEFAULTS.minDepositAtomic) ||
        terms.expiresAt <= options.now() ||
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
      receipts: options.receipts,
      now: options.now,
      offers: options.offers,
    }),
  };
}
// Empty transport identity is only a candidate; backend.renew verifies exact unsigned durable state. A
// session preparing without a channel is bound again through the backend before an OPEN with its terms,
// so the registry checks capacity and indexes the buyer first (a released never-funded one left the
// index); new terms still renew.
async function refuseBusyOrRebind(
  state: { current?: Binding },
  replacing: boolean,
  opening: boolean,
) {
  const snapshot = state.current?.session.snapshot();
  const preparing =
    snapshot?.state === SESSION_STATES.OPENING && snapshot.channelId === '';
  if (replacing && snapshot?.state !== SESSION_STATES.CLOSED && !preparing)
    return batchFail(SESSION_CODES.BUSY);
  if (!preparing || replacing || !opening) return;
  await state.current!.session.dispose();
  state.current = undefined;
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
  if (!state.current) {
    const stored = await options.backend.inspect();
    if (stored)
      state.current = binding(
        options,
        ownTerms(stored.terms, options, false),
        await options.backend.create(stored.terms),
      );
  }
  if (
    request.method === BATCH_METHODS.PREPARE ||
    request.method === BATCH_METHODS.OPEN
  ) {
    const proposed = request.params.terms ?? state.current?.terms;
    if (!proposed) return batchFail();
    const replacing =
      state.current !== undefined &&
      canonicalJson(state.current.terms) !== canonicalJson(proposed);
    const terms = ownTerms(proposed, options, !state.current || replacing);
    await refuseBusyOrRebind(
      state,
      replacing,
      request.method === BATCH_METHODS.OPEN,
    );
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
    if (request.method === BATCH_METHODS.PREPARE || !state.current || replacing)
      await options.admit?.();
    if (request.method === BATCH_METHODS.PREPARE) return { terms };
    if (replacing && state.current) {
      if (!options.backend.renew) return batchFail(SESSION_CODES.CLOSED);
      const expected = state.current.session.snapshot().channelId;
      await state.current.session.dispose();
      state.current = undefined;
      await options.backend.renew(expected, terms, request.params.payload);
    }
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
  const report = sellerChannelDiagnostics(options.diagnostics);
  const run = async <T>(
    peer: string,
    signal: AbortSignal,
    method: SellerChannelOperation,
    operation: () => Promise<T>,
  ) => {
    if (closed) return batchFail(SESSION_CODES.UNAVAILABLE);
    if (peer !== options.buyerNodeId)
      return batchFail(PAID_EXECUTION_CODES.PEER);
    if (active) return batchFail(SESSION_CODES.BUSY);
    signal.throwIfAborted();
    const running = report(method, operation);
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
    ownsSession: () => {
      if (!state.current) return false;
      try {
        return state.current.session.snapshot().state !== SESSION_STATES.CLOSED;
      } catch {
        // An unreadable journal must retain its owner and its recovery timer.
        return true;
      }
    },
    service: {
      exchange: (request, peer, signal, onDelta, blocks, blockMode) =>
        run(peer, signal, request.method, () =>
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
        run(peer, signal, SELLER_CHANNEL_DIAGNOSTICS.resumeBlock, () => {
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
