// Builds one durable zero-charge deposit, then signs cumulative vouchers only after usage approval.
// Reopening retains the original channel, hints and salt; it never silently tops up or rotates.
import { randomBytes } from 'node:crypto';

import { blockhash } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@x402/svm';
import {
  buildDepositPayload,
  signBatchVoucher,
} from '@x402/svm/batch-settlement/client';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { canonicalJson } from '@gyblos/protocol';
import { paymentSplits } from '@gyblos/protocol/payment-binding';
import {
  PAYMENT_SESSION,
  SESSION_CODES,
  SESSION_STATES,
  sessionFail,
  type SessionBuyer,
} from '@gyblos/protocol/payment-session';

import {
  atomic,
  billFor,
  requirementsFor,
  termsFor,
} from './batch-session-checks';
import {
  active,
  initialRecord,
  reserve,
  snapshot,
} from './batch-session-common';
import { openBatchStore, serial, type BatchStore } from './batch-session-store';
import type { BatchBuyerOptions } from './batch-session-types';

export async function createBatchBuyer(
  input: BatchBuyerOptions,
): Promise<SessionBuyer> {
  const options = { ...input, terms: termsFor(input.terms) };
  if (options.payer.address !== options.terms.buyer)
    sessionFail(SESSION_CODES.BINDING);
  const store = await openBatchStore(
    options,
    initialRecord(options.terms, options.now()),
  );
  const exclusive = serial();
  return {
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

async function openBuyer(
  options: BatchBuyerOptions,
  store: BatchStore,
  check?: () => void,
) {
  const beforeSign = () => {
    check?.();
    if (options.now() >= options.terms.expiresAt)
      return sessionFail(SESSION_CODES.CLOSED);
  };
  beforeSign();
  const current = store.read();
  if (options.now() >= options.terms.expiresAt)
    sessionFail(SESSION_CODES.CLOSED);
  if (
    current.state === SESSION_STATES.CLOSED ||
    current.state === SESSION_STATES.CLOSING
  )
    sessionFail(SESSION_CODES.CLOSED);
  if (current.opening) return JSON.stringify(current.opening);
  if (!current.hints) {
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
  const requirements = await requirementsFor(options.terms);
  const built = await buildDepositPayload({
    payer: {
      address: options.payer.address,
      signMessages: (...args) => {
        beforeSign();
        return options.payer.signMessages(...args);
      },
      signTransactions: (...args) => {
        beforeSign();
        return options.payer.signTransactions(...args);
      },
    },
    receiver: options.terms.payTo,
    receiverAuthorizer: options.terms.authorizer,
    mint: options.terms.mint,
    feePayer: options.terms.feePayer,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    blockhash: {
      blockhash: blockhash(hints.blockhash),
      lastValidBlockHeight: BigInt(hints.lastValidBlockHeight),
    },
    openSlot: BigInt(hints.slot),
    salt: BigInt(prepared.salt),
    depositAmount: BigInt(options.terms.depositAtomic),
    firstCharge: 0n,
    allowZeroFirstCharge: true,
    withdrawDelay: options.terms.withdrawDelaySeconds,
    memo: String(requirements.extra?.memo),
    splits: paymentSplits(options.terms),
  });
  await store.update((state) => {
    state.channelId = built.channelId;
    state.opening = built.payload;
    state.voucher = built.payload.voucher ?? null;
    state.state = SESSION_STATES.OPEN;
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
