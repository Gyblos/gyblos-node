// Stores buyer-authorized totals before acknowledging them; the autonomous worker owns final closure.
// No engine calls, automatic topups or prompt retries. Financial reservations outlive request signals.
import { getTransactionDecoder } from '@solana/kit';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import { controlInteger } from '@gyblos/protocol/control-validation';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type SessionBill,
  type SessionSeller,
} from '@gyblos/protocol/payment-session';
import type { SessionBlockSeller } from '@gyblos/protocol/session-blocks';

import {
  acceptSellerBlock,
  checkpointSeller,
  resumeSellerBlock,
} from './batch-block-seller';
import {
  requireSettlementResponse,
  requireVerifiedPayer,
} from './batch-sdk-diagnostics';
import {
  atomic,
  billFor,
  openingFor,
  requirementsFor,
  termsFor,
  voucherFor,
} from './batch-session-checks';
import { closeBatch, tickBatch } from './batch-session-close';
import {
  active,
  initialRecord,
  reserve,
  snapshot,
} from './batch-session-common';
import { openBatchStore, serial, type BatchStore } from './batch-session-store';
import type {
  BatchSellerContext,
  BatchSellerOptions,
} from './batch-session-types';
import { waitBatch } from './batch-session-wait';

export async function createBatchSeller(
  input: BatchSellerOptions,
): Promise<SessionBlockSeller> {
  const options = { ...input, terms: termsFor(input.terms) };
  if (options.authorizer.address !== options.terms.authorizer)
    sessionFail(SESSION_CODES.BINDING);
  controlInteger(options.idleMs ?? BATCH_SESSION_DEFAULTS.idleMs, 1);
  controlInteger(options.pollMs ?? BATCH_SESSION_DEFAULTS.pollMs, 1);
  controlInteger(options.operationMs ?? BATCH_SESSION_DEFAULTS.operationMs, 1);
  atomic(
    options.minSettlementAtomic ?? BATCH_SESSION_DEFAULTS.minSettlementAtomic,
  );
  const requirements = await requirementsFor(options.terms);
  const store = await openBatchStore(
    options,
    initialRecord(options.terms, options.now()),
  );
  const exclusive = serial();
  const current = store.read();
  let facilitator;
  try {
    facilitator = await waitBatch(
      options.facilitator(
        store.pending,
        current.opening
          ? {
              channelId: current.channelId,
              config: current.opening.channelConfig,
            }
          : undefined,
      ),
      options.operationMs,
    );
  } catch (error) {
    await store.dispose();
    throw error;
  }
  const context: BatchSellerContext = {
    blockExecutions: new Set(),
    options,
    store,
    requirements,
    facilitator,
  };
  const timer = setInterval(() => {
    void exclusive(() => tickBatch(context)).catch(() => {
      /* Durable state remains retryable; tick exposes the static failure to hosts. */
    });
  }, options.pollMs ?? BATCH_SESSION_DEFAULTS.pollMs);
  timer.unref();
  return {
    resumeBlock: (approval, peer) =>
      exclusive(() => resumeSellerBlock(context, approval, peer)),
    reserveBlocks: (request, peer) =>
      exclusive(async () => {
        await reserveSeller(context, request, peer, true);
        context.blockExecutions.add(request.requestId);
      }),
    checkpoint: (intent) => exclusive(() => checkpointSeller(context, intent)),
    acceptBlock: (intent, voucher, peer) =>
      exclusive(() => acceptSellerBlock(context, intent, voucher, peer)),
    releaseBlocks: (requestId) =>
      exclusive(async () => {
        context.blockExecutions.delete(requestId);
      }),
    open: (payload) => exclusive(() => openSeller(context, payload)),
    reserve: (request, peer) =>
      exclusive(() => reserveSeller(context, request, peer)),
    finish: (requestId, chargedAtomic) =>
      exclusive(() => finishSeller(context, requestId, chargedAtomic)),
    accept: (bill, voucher, peer) =>
      exclusive(() => acceptSeller(context, bill, voucher, peer)),
    close: () => exclusive(() => closeBatch(context)),
    tick: () => exclusive(() => tickBatch(context)),
    snapshot: () => snapshot(store),
    async dispose() {
      clearInterval(timer);
      await exclusive(store.dispose);
    },
  };
}
// SDK deposit verification reads/validates authority; it does not submit or simulate a payment.
async function verifyFirstOpening(
  context: BatchSellerContext,
  opening: ReturnType<typeof openingFor>,
) {
  const { options, facilitator, requirements } = context;
  const verified = await waitBatch(
    facilitator.verify(
      { x402Version: 2, accepted: requirements, payload: opening },
      requirements,
    ),
    options.operationMs,
  );
  requireVerifiedPayer(verified, options.terms.buyer);
}
async function openSeller(context: BatchSellerContext, payload: string) {
  const { options, store, facilitator, requirements } = context;
  if (options.now() >= options.terms.expiresAt)
    sessionFail(SESSION_CODES.CLOSED);
  if (Buffer.byteLength(payload) > BATCH_SESSION_DEFAULTS.stateBytes)
    sessionFail(SESSION_CODES.LIMIT);
  const opening = openingFor(JSON.parse(payload), options.terms);
  const state = store.read();
  if (state.opening && canonicalJson(state.opening) !== canonicalJson(opening))
    sessionFail(SESSION_CODES.BINDING);
  if (
    state.state === SESSION_STATES.CLOSED ||
    state.state === SESSION_STATES.CLOSING
  )
    sessionFail(SESSION_CODES.CLOSED);
  if (state.state === SESSION_STATES.OPEN) return snapshot(store);
  if (!state.opening) await verifyFirstOpening(context, opening);
  await store.update((state) => {
    state.opening = opening;
    state.channelId = opening.voucher!.channelId;
    state.voucher = opening.voucher!;
  });
  // waitBatch stops waiting but cannot cancel the SDK: a settlement still running may yet send the deposit.
  // The opening is forgotten only when the chain never showed the channel, no settlement for the session
  // is still running and this one, if started, has finished.
  let observed = false;
  let finished = true;
  try {
    observed = await waitBatch(
      options.observeOpening(
        structuredClone(opening),
        structuredClone(options.terms),
      ),
      options.operationMs,
    );
    if (observed) {
      const verdict = await waitBatch(
        facilitator.verify(
          {
            x402Version: 2,
            accepted: requirements,
            payload: {
              type: 'voucher',
              channelConfig: opening.channelConfig,
              voucher: opening.voucher,
            },
          },
          requirements,
        ),
        options.operationMs,
      );
      requireVerifiedPayer(verdict, options.terms.buyer);
    } else {
      finished = false;
      settling.set(store, (settling.get(store) ?? 0) + 1);
      const settlement = facilitator
        .settle(
          { x402Version: 2, accepted: requirements, payload: opening },
          requirements,
        )
        .finally(() => {
          finished = true;
          settling.set(store, (settling.get(store) ?? 1) - 1);
        });
      requireSettlementResponse(
        await waitBatch(settlement, options.operationMs),
        requirements.network,
      );
    }
  } catch (error) {
    if (!observed && finished && !settling.get(store))
      await forgetUnsentOpening(store, opening).catch(() => {
        markReleaseFailure(error);
      });
    throw error;
  }
  await store.update((state) => {
    state.state = SESSION_STATES.OPEN;
    state.lastActivity = options.now();
  });
  return snapshot(store);
}
// Deposit settlements still running for a session, including ones a timed-out wait left behind.
const settling = new WeakMap<BatchStore, number>();
// Set on an opening failure whose release could not be written, so the host can record it separately
// while the opening failure stays the reported error.
export const OPENING_RELEASE_FAILED = Symbol.for(
  'gyblos.batch.openingReleaseFailed',
);
function markReleaseFailure(error: unknown) {
  try {
    if (error && typeof error === 'object' && Object.isExtensible(error))
      Object.defineProperty(error, OPENING_RELEASE_FAILED, { value: true });
  } catch {
    /* The opening failure is still reported. */
  }
}
const WIRE_KEY = /^batch:transaction:.+:wire$/;
// The SDK stores a signed attempt as a `…:wire` transaction keyed by signature before it reserves the
// channel key and sends. With no key naming the channel, an attempt of this deposit was never sent or
// failed on chain (the SDK drops the channel key only then, or discards the wire itself), so its wire is
// no evidence of funds; any other key keeps everything.
function depositAttempts(
  pending: Record<string, string>,
  opening: ReturnType<typeof openingFor>,
) {
  const message = Buffer.from(
    getTransactionDecoder().decode(
      Buffer.from(opening.deposit.transaction, 'base64'),
    ).messageBytes,
  );
  return Object.entries(pending).flatMap(([key, wire]) => {
    if (!WIRE_KEY.test(key)) return [];
    try {
      const sent = getTransactionDecoder().decode(Buffer.from(wire, 'base64'));
      return message.equals(Buffer.from(sent.messageBytes)) ? [key] : [];
    } catch {
      return [];
    }
  });
}
// Only this seller's fee payer completes the buyer's deposit, and the SDK records an attempt under the
// channel before it signs or sends. With no such record the deposit was never sent or failed on chain,
// and can never land: keeping the opening would leave a channel the seller later tries to close forever
// and block the buyer's next channel. The match on the channel is deliberately wide because the SDK's
// key format is internal; an extra match only keeps the opening.
async function forgetUnsentOpening(
  store: BatchStore,
  opening: ReturnType<typeof openingFor>,
) {
  const channelId = opening.voucher!.channelId;
  await store.update((state) => {
    if (
      state.state !== SESSION_STATES.OPENING ||
      state.channelId !== channelId ||
      Object.keys(state.pending).some((key) => key.includes(channelId))
    )
      return;
    for (const key of depositAttempts(state.pending, opening))
      delete state.pending[key];
    state.opening = null;
    state.channelId = '';
    state.voucher = null;
  });
}
async function finishSeller(
  context: BatchSellerContext,
  requestId: string,
  chargedAtomic: string,
): Promise<SessionBill> {
  const amount = atomic(chargedAtomic);
  let bill: SessionBill | undefined;
  await context.store.update((state) => {
    active(state, context.options.now());
    const request = state.requests[requestId];
    if (state.blocks?.[requestId]) return sessionFail(SESSION_CODES.BINDING);
    if (!request || request.bill || request.accepted)
      sessionFail(SESSION_CODES.BINDING);
    if (BigInt(amount) > BigInt(request.maxAtomic))
      sessionFail(SESSION_CODES.LIMIT);
    bill = {
      requestId,
      requestDigest: request.requestDigest,
      maxAtomic: request.maxAtomic,
      chargedAtomic: amount,
      cumulativeAtomic: String(BigInt(state.cumulativeAtomic) + BigInt(amount)),
    };
    request.bill = bill;
    state.lastActivity = context.options.now();
  });
  if (!bill) return sessionFail(SESSION_CODES.UNAVAILABLE);
  return bill;
}
async function acceptSeller(
  context: BatchSellerContext,
  inputBill: SessionBill,
  inputVoucher: Parameters<SessionSeller['accept']>[1],
  peer: string,
) {
  const { options, store, facilitator, requirements } = context;
  if (peer !== options.terms.buyerNodeId) sessionFail(SESSION_CODES.BINDING);
  const bill = billFor(inputBill);
  const voucher = voucherFor(inputVoucher);
  const state = store.read();
  active(state, options.now());
  const request = state.requests[bill.requestId];
  if (state.blocks?.[bill.requestId]) return sessionFail(SESSION_CODES.BINDING);
  if (
    !request?.bill ||
    canonicalJson(request.bill) !== canonicalJson(bill) ||
    voucher.channelId !== state.channelId ||
    voucher.maxClaimableAmount !== bill.cumulativeAtomic
  )
    sessionFail(SESSION_CODES.BINDING);
  if (request.accepted) return;
  if (
    BigInt(bill.cumulativeAtomic) !==
    BigInt(state.cumulativeAtomic) + BigInt(bill.chargedAtomic)
  )
    sessionFail(SESSION_CODES.BINDING);
  const verdict = await waitBatch(
    facilitator.verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: {
          type: 'voucher',
          channelConfig: state.opening!.channelConfig,
          voucher,
        },
      },
      { ...requirements, amount: bill.chargedAtomic },
    ),
    options.operationMs,
  );
  requireVerifiedPayer(verdict, options.terms.buyer);
  await store.update((state) => {
    state.voucher = voucher;
    state.cumulativeAtomic = bill.cumulativeAtomic;
    state.requests[bill.requestId]!.accepted = true;
    state.lastActivity = options.now();
  });
}

async function reserveSeller(
  context: BatchSellerContext,
  request: Parameters<SessionSeller['reserve']>[0],
  peer: string,
  blocks = false,
) {
  const { options, store, facilitator, requirements } = context;

  if (peer !== options.terms.buyerNodeId) sessionFail(SESSION_CODES.BINDING);
  const state = store.read();
  active(state, options.now());
  if (!state.opening || !state.voucher) sessionFail(SESSION_CODES.UNAVAILABLE);
  const verdict = await waitBatch(
    facilitator.verify(
      {
        x402Version: 2,
        accepted: requirements,
        payload: {
          type: 'voucher',
          channelConfig: state.opening.channelConfig,
          voucher: state.voucher,
        },
      },
      requirements,
    ),
    options.operationMs,
  );
  requireVerifiedPayer(verdict, options.terms.buyer);
  await reserve(store, request, options.now(), blocks);
}
