// Builds one durable zero-charge deposit, then signs cumulative vouchers only after usage approval.
// Reopening retains the original channel, hints and salt; it never silently tops up or rotates.
import { randomBytes } from 'node:crypto';

import { signBatchVoucher } from '@x402/svm/batch-settlement/client';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type SessionBuyer,
} from '@gyblos/protocol/payment-session';
import type { SessionBlockBuyer } from '@gyblos/protocol/session-blocks';

import {
  acknowledgeBuyerBlock,
  approveBuyerBlock,
  recoverBuyerBlock,
} from './batch-block-buyer';
import { buildBuyerOpening } from './batch-opening-build';
import { batchOpeningAbsent } from './batch-opening-proof';
import { batchOpeningSigner } from './batch-opening-signer';
import { atomic, billFor, termsFor } from './batch-session-checks';
import {
  active,
  initialRecord,
  reserve,
  snapshot,
} from './batch-session-common';
import { openBatchStore, serial, type BatchStore } from './batch-session-store';
import type { BatchBuyerOptions } from './batch-session-types';
import { BATCH_BLOCK_STATE, BATCH_BUYER_CHECKPOINTS } from './constants';

export async function createBatchBuyer(
  input: BatchBuyerOptions,
): Promise<SessionBlockBuyer> {
  const options = { ...input, terms: termsFor(input.terms) };
  if (options.payer.address !== options.terms.buyer)
    sessionFail(SESSION_CODES.BINDING);
  const store = await openBatchStore(
    options,
    initialRecord(options.terms, options.now()),
  );
  const exclusive = serial();
  return {
    usesBlocks: () => store.read().version === BATCH_BLOCK_STATE.version,
    pendingBlockRequest: () => {
      const state = store.read();
      const request = Object.values(state.requests).find(
        (row) => !row.accepted && state.blocks?.[row.requestId],
      );
      return request
        ? {
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            maxAtomic: request.maxAtomic,
          }
        : undefined;
    },
    beginBlocks: (request) =>
      exclusive(() => reserve(store, request, options.now(), true)),
    approveBlock: (intent, verified, check) =>
      exclusive(() =>
        approveBuyerBlock(options, store, intent, verified, check),
      ),
    acknowledgeBlock: (intent) =>
      exclusive(() => acknowledgeBuyerBlock(options, store, intent)),
    recoverBlockApproval: () =>
      exclusive(() => recoverBuyerBlock(options, store)),
    open: (check) => exclusive(() => openBuyer(options, store, check)),
    begin: (request) => exclusive(() => reserve(store, request, options.now())),
    approve: (inputBill, verifiedAtomic) =>
      exclusive(() => approveBuyer(options, store, inputBill, verifiedAtomic)),
    acknowledge: (requestId) =>
      exclusive(() =>
        store.update((state) => {
          const request = state.requests[requestId];
          if (
            !request?.bill ||
            state.voucher?.maxClaimableAmount !== request.bill.cumulativeAtomic
          )
            sessionFail(SESSION_CODES.BINDING);
          request.accepted = true;
        }),
      ),
    reconcile: (observe) =>
      exclusive(async () => {
        const current = store.read();
        if (current.settlement) return current.settlement;
        const observed = await observe(current.channelId);
        if (!observed) return undefined;
        if (
          observed.channelId !== current.channelId ||
          BigInt(atomic(observed.chargedAtomic)) >
            BigInt(current.cumulativeAtomic) ||
          BigInt(atomic(observed.refundedAtomic)) +
            BigInt(observed.chargedAtomic) !==
            BigInt(options.terms.depositAtomic) ||
          !observed.transaction
        )
          sessionFail(SESSION_CODES.UNVERIFIED);
        await store.update((state) => {
          state.settlement = observed;
          state.state = SESSION_STATES.CLOSED;
        });
        return observed;
      }),
    recoverApproval: () => exclusive(() => recoverApproval(options, store)),
    snapshot: () => snapshot(store),
    dispose: () => exclusive(store.dispose),
  };
}

export async function openBuyer(
  options: BatchBuyerOptions,
  store: BatchStore,
  check?: () => void,
  recovering = false,
) {
  const beforeSign = () => {
    check?.();
    if (options.now() >= options.terms.expiresAt)
      return sessionFail(SESSION_CODES.CLOSED);
  };
  if (!recovering) beforeSign();
  const current = store.read();
  if (!recovering && options.now() >= options.terms.expiresAt)
    sessionFail(SESSION_CODES.CLOSED);
  if (
    current.state === SESSION_STATES.CLOSED ||
    current.state === SESSION_STATES.CLOSING
  )
    sessionFail(SESSION_CODES.CLOSED);
  if (batchOpeningAbsent(current)) return sessionFail(SESSION_CODES.CLOSED);
  if (current.opening) return JSON.stringify(current.opening);
  if (!current.hints) {
    if (recovering) return sessionFail(SESSION_CODES.UNVERIFIED);
    const hints = await options.hints();
    const salt = String(
      randomBytes(BATCH_SESSION_DEFAULTS.saltBytes).readBigUInt64LE(),
    );
    await store.update((state) => {
      state.hints = hints;
      state.salt = salt;
    });
  }
  const prepared = store.read();
  const hints = prepared.hints;
  if (!hints) return sessionFail(SESSION_CODES.UNAVAILABLE);
  const built = await buildBuyerOpening(
    prepared,
    batchOpeningSigner(options.payer, store, beforeSign, recovering),
  );
  await store.update((state) => {
    state.channelId = built.channelId;
    state.opening = built.payload;
    state.voucher = built.payload.voucher ?? null;
    state.state = SESSION_STATES.OPEN;
    delete state.pending[BATCH_BUYER_CHECKPOINTS.OPENING_TRANSACTION];
    delete state.pending[BATCH_BUYER_CHECKPOINTS.OPENING_VOUCHER];
  });
  return JSON.stringify(built.payload);
}

async function approveBuyer(
  options: BatchBuyerOptions,
  store: BatchStore,
  inputBill: Parameters<SessionBuyer['approve']>[0],
  verifiedAtomic: string,
) {
  const bill = billFor(inputBill);
  const current = store.read();
  if (current.blocks?.[bill.requestId])
    return sessionFail(SESSION_CODES.BINDING);
  active(current, options.now());
  const request = current.requests[bill.requestId];
  if (
    !request ||
    request.requestDigest !== bill.requestDigest ||
    request.maxAtomic !== bill.maxAtomic ||
    bill.chargedAtomic !== atomic(verifiedAtomic)
  )
    sessionFail(SESSION_CODES.UNVERIFIED);
  if (request.bill && canonicalJson(request.bill) !== canonicalJson(bill))
    sessionFail(SESSION_CODES.BINDING);
  if (
    request.bill &&
    canonicalJson(request.bill) === canonicalJson(bill) &&
    current.voucher?.maxClaimableAmount === bill.cumulativeAtomic
  )
    return current.voucher;
  if (request.accepted) {
    if (
      canonicalJson(request.bill) !== canonicalJson(bill) ||
      !current.voucher ||
      current.voucher.maxClaimableAmount !== bill.cumulativeAtomic
    )
      sessionFail(SESSION_CODES.BINDING);
    return current.voucher;
  }
  if (
    BigInt(bill.cumulativeAtomic) !==
      BigInt(current.cumulativeAtomic) + BigInt(verifiedAtomic) ||
    BigInt(bill.cumulativeAtomic) > BigInt(options.terms.depositAtomic)
  )
    sessionFail(SESSION_CODES.LIMIT);
  // The exact intended total is durable before its signature can escape this process.
  await store.update((state) => {
    state.requests[bill.requestId]!.bill = bill;
  });
  const voucher = await signBatchVoucher(options.payer, {
    channelId: current.channelId,
    maxClaimableAmount: BigInt(bill.cumulativeAtomic),
    expiresAt: PAYMENT_SESSION.voucherExpiry,
  });
  await store.update((state) => {
    state.voucher = voucher;
    state.cumulativeAtomic = bill.cumulativeAtomic;
    state.lastActivity = options.now();
  });
  return voucher;
}

async function recoverApproval(options: BatchBuyerOptions, store: BatchStore) {
  const current = store.read();
  const pending = Object.values(current.requests).find(
    (request) => !request.accepted && request.bill !== null,
  );
  if (!pending?.bill) return undefined;
  const bill = pending.bill;
  const voucher =
    current.voucher?.maxClaimableAmount === bill.cumulativeAtomic
      ? current.voucher
      : await signBatchVoucher(options.payer, {
          channelId: current.channelId,
          maxClaimableAmount: BigInt(bill.cumulativeAtomic),
          expiresAt: PAYMENT_SESSION.voucherExpiry,
        });
  await store.update((state) => {
    state.voucher = voucher;
    state.cumulativeAtomic = bill.cumulativeAtomic;
  });
  return { bill, voucher };
}
