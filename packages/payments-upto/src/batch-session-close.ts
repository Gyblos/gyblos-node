// Freezes the highest buyer voucher before autonomous seller close; retries never change that total.
import { signCloseAuthorization } from '@x402/svm';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
} from '@gyblos/protocol/payment-session';

import type { BatchSellerContext } from './batch-session-types';
import { waitBatch } from './batch-session-wait';

async function prepareClose(context: BatchSellerContext) {
  const { options, store, requirements } = context;
  const previous = store.read();
  if (!previous.opening || !previous.voucher)
    sessionFail(SESSION_CODES.UNAVAILABLE);
  await store.update((state) => {
    state.state = SESSION_STATES.CLOSING;
  });
  const seconds = Math.floor(
    options.now() / BATCH_SESSION_DEFAULTS.millisecondsPerSecond,
  );
  if (
    previous.closing &&
    (previous.closing.type === 'refund' || previous.closing.type === 'seal') &&
    (previous.closing.closeAuthorization?.validBefore ?? 0) > seconds
  )
    return;
  const closeAuthorization = await waitBatch(
    signCloseAuthorization(options.authorizer, {
      channelId: previous.channelId,
      feePayer: options.terms.feePayer,
      maxClaimableAmount: BigInt(previous.cumulativeAtomic),
      network: requirements.network,
      validBefore: seconds + requirements.maxTimeoutSeconds,
      voucherExpiresAt: BigInt(previous.voucher.expiresAt),
    }),
    options.operationMs,
  );
  const closing = await waitBatch(
    options.closing(previous.channelId),
    options.operationMs,
  );
  await store.update((state) => {
    // Renew only the seller's transport authorization. The buyer voucher/amount and pending SDK
    // transaction checkpoints remain unchanged, including when the previous response was lost.
    state.closing = closing
      ? {
          type: 'seal',
          channelId: previous.channelId,
          channelConfig: previous.opening!.channelConfig,
          voucher: previous.voucher!,
          closeAuthorization,
        }
      : {
          type: 'refund',
          channelConfig: previous.opening!.channelConfig,
          voucher: previous.voucher!,
          closeAuthorization,
        };
  });
}
export async function closeBatch(context: BatchSellerContext) {
  const { options, store, facilitator, requirements } = context;
  const previous = store.read();
  if (previous.settlement) return previous.settlement;
  await store.update((state) => {
    state.state = SESSION_STATES.CLOSING;
  });
  const known = await waitBatch(
    options.observe(previous.channelId),
    options.operationMs,
  );
  if (known) return acceptSettlement(context, known);
  await prepareClose(context);
  const frozen = store.read();
  if (!frozen.closing) return sessionFail(SESSION_CODES.UNAVAILABLE);
  const response = await waitBatch(
    facilitator.settle(
      { x402Version: 2, accepted: requirements, payload: frozen.closing },
      requirements,
    ),
    options.operationMs,
  );
  const observed = await waitBatch(
    options.observe(frozen.channelId),
    options.operationMs,
  );
  if (observed) return acceptSettlement(context, observed);
  if (
    !response.success ||
    response.network !== requirements.network ||
    !response.transaction
  )
    sessionFail(SESSION_CODES.UNAVAILABLE);
  return sessionFail(SESSION_CODES.UNVERIFIED);
}
export async function tickBatch(context: BatchSellerContext) {
  const { options, store } = context;
  const state = store.read();
  if (!state.opening || state.state === SESSION_STATES.CLOSED) return undefined;
  const idle =
    options.now() - state.lastActivity >=
    (options.idleMs ?? BATCH_SESSION_DEFAULTS.idleMs);
  const unsigned = Object.values(state.requests).some(
    (request) => !request.accepted && request.bill !== null,
  );
  const generating = Object.values(state.requests).some(
    (request) => !request.accepted && request.bill === null,
  );
  const threshold = BigInt(
    options.minSettlementAtomic ?? BATCH_SESSION_DEFAULTS.minSettlementAtomic,
  );
  if (
    state.state === SESSION_STATES.CLOSING ||
    options.now() >= options.terms.expiresAt ||
    BigInt(state.cumulativeAtomic) >= BigInt(options.terms.depositAtomic) ||
    Object.keys(state.requests).length >= BATCH_SESSION_DEFAULTS.maxRequests ||
    (await waitBatch(options.closing(state.channelId), options.operationMs)) ||
    (idle &&
      !generating &&
      (unsigned || BigInt(state.cumulativeAtomic) >= threshold))
  )
    return closeBatch(context);
  return undefined;
}

async function acceptSettlement(
  context: BatchSellerContext,
  settlement: import('@gyblos/protocol/payment-session').SessionSettlement,
) {
  const frozen = context.store.read();
  if (
    settlement.channelId !== frozen.channelId ||
    settlement.chargedAtomic !== frozen.cumulativeAtomic ||
    BigInt(settlement.refundedAtomic) + BigInt(settlement.chargedAtomic) !==
      BigInt(context.options.terms.depositAtomic) ||
    !settlement.transaction
  )
    sessionFail(SESSION_CODES.UNVERIFIED);
  await context.store.update((state) => {
    state.settlement = settlement;
    state.state = SESSION_STATES.CLOSED;
  });
  return settlement;
}
