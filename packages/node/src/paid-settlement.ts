// Admits a paid request's deposit and settles its charge through the payment port. Settlement runs
// under the daemon's signal, never the request's, so it completes after the buyer leaves; a claim not
// confirmed within the wait is reported pending and handed to the caller to retry with the same charge.
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
  type PaymentServer,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

export interface PaidSettlementOptions {
  // The daemon's lifetime: aborting it reports open claims pending instead of waiting.
  signal: AbortSignal;
  // How long a terminal waits for the claim before reporting it pending.
  waitMs: number;
  // A claim reported pending, to retry with exactly this charge; the charge was not refused.
  onPending?(admission: PaymentAdmission, chargedAtomic: string): void;
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

export async function admitDeposit(
  payment: PaymentServer,
  request: PaidExecutionRequest,
  terms: PaymentTerms,
  signal: AbortSignal,
): Promise<PaymentAdmission> {
  try {
    return await payment.admit(request.payment, terms, { signal });
  } catch (error) {
    if (error instanceof PaymentError) return fail(ADMIT_CODES[error.code]);
    if (signal.aborted) return fail(PAID_EXECUTION_CODES.CANCELLED);
    return fail(PAID_EXECUTION_CODES.INTERNAL);
  }
}

const OUTCOMES = { TIMEOUT: 'timeout', STOPPED: 'stopped' } as const;
type Wait = (typeof OUTCOMES)[keyof typeof OUTCOMES];

// Resolves when the wait ends or the daemon stops, whichever comes first.
function waitFor(options: PaidSettlementOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  const ended = new Promise<Wait>((resolve) => {
    timer = setTimeout(() => resolve(OUTCOMES.TIMEOUT), options.waitMs);
    stop = () => resolve(OUTCOMES.STOPPED);
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();
  });
  return {
    ended,
    clear() {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', stop);
    },
  };
}

export async function settleCharge(
  payment: PaymentServer,
  admission: PaymentAdmission,
  chargedAtomic: string,
  options: PaidSettlementOptions,
): Promise<PaidPayment> {
  const pending = (): PaidPayment => {
    options.onPending?.(admission, chargedAtomic);
    return {
      pending: {
        channelId: admission.channelId,
        chargedAtomic,
        transaction: null,
      },
    };
  };
  if (options.signal.aborted) return pending();
  const settling = payment.settle(admission, chargedAtomic);
  const wait = waitFor(options);
  try {
    const outcome = await Promise.race([settling, wait.ended]);
    if (typeof outcome === 'string') return pending();
    return { settlement: outcome };
  } catch (error) {
    if (
      error instanceof PaymentError &&
      error.code === PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED
    )
      return { lapsed: { channelId: admission.channelId } };
    return pending();
  } finally {
    wait.clear();
    // A claim still running after the wait is observed, so its failure is never unhandled.
    settling.catch(() => undefined);
  }
}
