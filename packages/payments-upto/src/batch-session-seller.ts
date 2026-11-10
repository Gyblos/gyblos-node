// Stores buyer-authorized totals before acknowledging them; the autonomous worker owns final closure.
// No engine calls, automatic topups or prompt retries. Financial reservations outlive request signals.
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
import { openBatchStore, serial } from './batch-session-store';
import type {
  BatchSellerContext,
  BatchSellerOptions,
} from './batch-session-types';
import { waitBatch } from './batch-session-wait';

export async function createBatchSeller(
  input: BatchSellerOptions,
): Promise<SessionSeller> {
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
  await store.update((state) => {
    state.opening = opening;
    state.channelId = opening.voucher!.channelId;
    state.voucher = opening.voucher!;
  });
  if (
    await waitBatch(
      options.observeOpening(
        structuredClone(opening),
        structuredClone(options.terms),
      ),
      options.operationMs,
    )
  ) {
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
    if (!verdict.isValid || verdict.payer !== options.terms.buyer)
      sessionFail(SESSION_CODES.UNVERIFIED);
    await store.update((state) => {
      state.state = SESSION_STATES.OPEN;
      state.lastActivity = options.now();
    });
    return snapshot(store);
  }
  const response = await waitBatch(
    facilitator.settle(
      { x402Version: 2, accepted: requirements, payload: opening },
      requirements,
    ),
    options.operationMs,
  );
  if (
    !response.success ||
    response.network !== requirements.network ||
    !response.transaction
  )
    sessionFail(SESSION_CODES.UNAVAILABLE);
  await store.update((state) => {
    state.state = SESSION_STATES.OPEN;
    state.lastActivity = options.now();
  });
  return snapshot(store);
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
  if (!verdict.isValid || verdict.payer !== options.terms.buyer)
    sessionFail(SESSION_CODES.UNVERIFIED);
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
  if (!verdict.isValid || verdict.payer !== options.terms.buyer)
    sessionFail(SESSION_CODES.UNVERIFIED);
  await reserve(store, request, options.now());
}
