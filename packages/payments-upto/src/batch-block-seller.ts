// Verifies and persists cumulative SDK vouchers before ACK; runtime execution leases never survive a restart.
import {
  SESSION_CODES,
  sessionFail,
  type SessionVoucher,
} from '@gyblos/protocol/payment-session';
import {
  parseSessionBlock,
  SESSION_BLOCK_KINDS,
  type SessionBlockApproval,
  type SessionBlockIntent,
} from '@gyblos/protocol/session-blocks';

import {
  acknowledgeBlock,
  intentFor,
  prepareBlock,
  progressFor,
  sameBlock,
} from './batch-block-operations';
import { voucherFor } from './batch-session-checks';
import { active } from './batch-session-common';
import type { BatchSellerContext } from './batch-session-types';
import { waitBatch } from './batch-session-wait';

export async function resumeSellerBlock(
  context: BatchSellerContext,
  input: SessionBlockApproval,
  peer: string,
) {
  const approval = parseSessionBlock(input);
  const state = context.store.read();
  if (
    approval.kind !== SESSION_BLOCK_KINDS.APPROVAL ||
    approval.channelId !== state.channelId ||
    peer !== context.options.terms.buyerNodeId
  )
    return sessionFail(SESSION_CODES.BINDING);
  const progress = state.blocks?.[approval.requestId];
  const intent = [progress?.pending?.intent, progress?.accepted].find(
    (value) =>
      value &&
      value.index === approval.index &&
      value.digest === approval.blockDigest &&
      value.bill.requestDigest === approval.requestDigest,
  );
  if (!intent) return sessionFail(SESSION_CODES.BINDING);
  await acceptSellerBlock(context, intent, approval.voucher, peer);
  return intent;
}

export async function checkpointSeller(
  context: BatchSellerContext,
  input: SessionBlockIntent,
) {
  const intent = intentFor(input);
  if (!context.blockExecutions.has(intent.bill.requestId))
    return sessionFail(SESSION_CODES.BINDING);
  await prepareBlock(context.store, intent, context.options.now());
}
export async function acceptSellerBlock(
  context: BatchSellerContext,
  input: SessionBlockIntent,
  inputVoucher: SessionVoucher,
  peer: string,
) {
  const { options, store } = context;
  if (peer !== options.terms.buyerNodeId)
    return sessionFail(SESSION_CODES.BINDING);
  const intent = intentFor(input);
  const voucher = voucherFor(inputVoucher);
  const state = store.read();
  active(state, options.now());
  const progress = progressFor(state, intent);
  const duplicate = sameBlock(progress.accepted, intent);
  if (!duplicate && !sameBlock(progress.pending?.intent ?? null, intent))
    return sessionFail(SESSION_CODES.BINDING);
  if (
    voucher.channelId !== state.channelId ||
    voucher.maxClaimableAmount !== intent.bill.cumulativeAtomic
  )
    return sessionFail(SESSION_CODES.BINDING);
  if (!state.opening) return sessionFail(SESSION_CODES.UNAVAILABLE);
  const verdict = await waitBatch(
    context.facilitator.verify(
      {
        x402Version: 2,
        accepted: context.requirements,
        payload: {
          type: 'voucher',
          channelConfig: state.opening.channelConfig,
          voucher,
        },
      },
      { ...context.requirements, amount: intent.bill.chargedAtomic },
    ),
    options.operationMs,
  );
  if (!verdict.isValid || verdict.payer !== options.terms.buyer)
    return sessionFail(SESSION_CODES.UNVERIFIED);
  if (duplicate) return;
  await store.update((record) => {
    const current = progressFor(record, intent);
    if (!sameBlock(current.pending?.intent ?? null, intent))
      return sessionFail(SESSION_CODES.BINDING);
    record.voucher = voucher;
    record.cumulativeAtomic = intent.bill.cumulativeAtomic;
    acknowledgeBlock(record, intent, options.now());
  });
  if (intent.terminal) context.blockExecutions.delete(intent.bill.requestId);
}
