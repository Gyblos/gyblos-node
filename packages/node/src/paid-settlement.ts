// Admits a paid request's deposit and settles its charge through the payment port, every call bounded
// by the wait. Settlement runs under the daemon's signal, never the request's, so it completes after
// the buyer leaves. A claim not confirmed in time, or retryably failed, is reported pending and handed
// to the caller to retry with the same charge; a deposit admitted after its request gave up is handed
// over with a charge of zero. Hooks never change a terminal.
import {
  PAYMENT_ERROR_CODES,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import {
  paidExecutionFail as fail,
  type PaidExecutionRequest,
  type PaidPayment,
} from '@gyblos/protocol/paid-execution';
import {
  PAID_EXECUTION_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentDescription,
  type PaymentServer,
  type PaymentSettlement,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import { PAID_RETRYABLE_PAYMENT_CODES } from './constants';

export interface PaidSettlementOptions {
  // The daemon's lifetime: once aborted, claims are reported pending without being started.
  signal: AbortSignal;
  // Bounds describing, admitting and the claim; keep it well under the transport's request deadline,
  // which also covers generation and the terminal write.
  waitMs: number;
  // A claim to retry with exactly this charge, which the payment server has not refused.
  onPending?(admission: PaymentAdmission, chargedAtomic: string): void;
  // A claim the payment server refused for a reason retrying cannot fix. The buyer is told it is
  // pending and reconciles on chain; the caller should surface it.
  onFailure?(
    admission: PaymentAdmission,
    chargedAtomic: string,
    error: unknown,
  ): void;
}

// Refusals happen before any deposit; an unreachable chain or journal is reported as such.
const ADMIT_CODES: Readonly<Record<PaymentErrorCode, PaidExecutionCode>> = {
  [PAYMENT_ERROR_CODES.UNTRUSTED_TERMS]: PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  [PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED]:
    PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  [PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH]:
    PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  [PAYMENT_ERROR_CODES.CHANNEL_REUSED]: PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  [PAYMENT_ERROR_CODES.INVALID_CHARGE]: PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  [PAYMENT_ERROR_CODES.RECEIPT_MISMATCH]: PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  [PAYMENT_ERROR_CODES.ALREADY_SETTLED]: PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  [PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED]:
    PAID_EXECUTION_CODES.PAYMENT_REJECTED,
  [PAYMENT_ERROR_CODES.TERMS_EXPIRED]: PAID_EXECUTION_CODES.EXPIRED,
  [PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE]:
    PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE,
  [PAYMENT_ERROR_CODES.UNAVAILABLE]: PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE,
};

const OUTCOMES = { TIMEOUT: 'timeout', STOPPED: 'stopped' } as const;
type Wait = (typeof OUTCOMES)[keyof typeof OUTCOMES];

// The operation, or why waiting for it ended first. The operation is always observed.
async function bounded<T>(
  operation: Promise<T>,
  options: PaidSettlementOptions,
): Promise<T | Wait> {
  operation.catch(() => undefined);
  // A stopped daemon waits for nothing, even for an operation that already finished.
  if (options.signal.aborted) return OUTCOMES.STOPPED;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  const ended = new Promise<Wait>((resolve) => {
    timer = setTimeout(() => resolve(OUTCOMES.TIMEOUT), options.waitMs);
    stop = () => resolve(OUTCOMES.STOPPED);
    options.signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([operation, ended]);
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', stop);
  }
}

const waited = <T>(outcome: T | Wait): outcome is Wait =>
  outcome === OUTCOMES.TIMEOUT || outcome === OUTCOMES.STOPPED;

// A hook that throws is the caller's bug; it must not cost the buyer a terminal.
function notify(run: () => void) {
  try {
    run();
  } catch {
    // Deliberately ignored: the terminal is already decided.
  }
}

export async function describeOwn(
  payment: PaymentServer,
  options: PaidSettlementOptions,
): Promise<PaymentDescription> {
  try {
    const outcome = await bounded(payment.describe(), options);
    if (!waited(outcome)) return outcome;
  } catch {
    // Reported as unavailable below.
  }
  return fail(PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE);
}

export async function admitDeposit(
  payment: PaymentServer,
  request: PaidExecutionRequest,
  terms: PaymentTerms,
  signal: AbortSignal,
  options: PaidSettlementOptions,
): Promise<PaymentAdmission> {
  // A stopping daemon takes no new deposits.
  if (options.signal.aborted)
    return fail(PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE);
  const admitting = Promise.resolve().then(() =>
    payment.admit(request.payment, terms, {
      signal,
      minClaimWindowMs: options.waitMs,
    }),
  );
  let outcome: PaymentAdmission | Wait;
  try {
    outcome = await bounded(admitting, options);
  } catch (error) {
    if (error instanceof PaymentError) return fail(ADMIT_CODES[error.code]);
    if (signal.aborted) return fail(PAID_EXECUTION_CODES.CANCELLED);
    return fail(PAID_EXECUTION_CODES.INTERNAL);
  }
  if (!waited(outcome)) return outcome;
  // The deposit may still land after this request gave up: nothing was served, so it settles at zero.
  admitting.then(
    (late) => notify(() => options.onPending?.(late, '0')),
    () => undefined,
  );
  return fail(PAID_EXECUTION_CODES.PAYMENT_UNAVAILABLE);
}

export async function settleCharge(
  payment: PaymentServer,
  admission: PaymentAdmission,
  chargedAtomic: string,
  options: PaidSettlementOptions,
): Promise<PaidPayment> {
  const pending: PaidPayment = {
    pending: {
      channelId: admission.channelId,
      chargedAtomic,
      transaction: null,
    },
  };
  const retry = () => {
    notify(() => options.onPending?.(admission, chargedAtomic));
    return pending;
  };
  if (options.signal.aborted) return retry();
  let outcome: PaymentSettlement | Wait;
  try {
    outcome = await bounded(payment.settle(admission, chargedAtomic), options);
  } catch (error) {
    if (error instanceof PaymentError) {
      if (error.code === PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED)
        return { lapsed: { channelId: admission.channelId } };
      if (PAID_RETRYABLE_PAYMENT_CODES.includes(error.code)) return retry();
    }
    notify(() => options.onFailure?.(admission, chargedAtomic, error));
    return pending;
  }
  return waited(outcome) ? retry() : { settlement: outcome };
}
