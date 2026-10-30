// Translates x402-upto-metered failures into payment port codes. Admission and settlement map a few
// codes differently: a refused deposit is a mismatch, a claim refused for good has lapsed.
import {
  UPTO_ERROR_CODES,
  UptoError,
  type UptoErrorCode,
} from 'x402-upto-metered';

import {
  PAYMENT_ERROR_CODES,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';

import { PAYMENT_PHASES, type PaymentPhase } from './constants';

const SHARED = {
  [UPTO_ERROR_CODES.INVALID_TERMS]: PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
  [UPTO_ERROR_CODES.AUTHORIZATION_MISMATCH]:
    PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
  [UPTO_ERROR_CODES.CHANNEL_REUSED]: PAYMENT_ERROR_CODES.CHANNEL_REUSED,
  [UPTO_ERROR_CODES.CHARGE_EXCEEDS_CEILING]: PAYMENT_ERROR_CODES.INVALID_CHARGE,
  [UPTO_ERROR_CODES.ALREADY_SETTLED]: PAYMENT_ERROR_CODES.ALREADY_SETTLED,
  [UPTO_ERROR_CODES.JOURNAL_UNAVAILABLE]: PAYMENT_ERROR_CODES.UNAVAILABLE,
  [UPTO_ERROR_CODES.FACILITATOR_REJECTED]:
    PAYMENT_ERROR_CODES.AUTHORIZATION_MISMATCH,
  [UPTO_ERROR_CODES.TERMS_EXPIRED]: PAYMENT_ERROR_CODES.TERMS_EXPIRED,
  [UPTO_ERROR_CODES.UNAVAILABLE]: PAYMENT_ERROR_CODES.UNAVAILABLE,
  [UPTO_ERROR_CODES.INTERNAL]: PAYMENT_ERROR_CODES.UNAVAILABLE,
} as const satisfies Record<UptoErrorCode, PaymentErrorCode>;

// A claim refused for good lapsed: nothing is charged, and retrying would not change that.
const SETTLEMENT: Partial<Record<UptoErrorCode, PaymentErrorCode>> = {
  [UPTO_ERROR_CODES.FACILITATOR_REJECTED]:
    PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED,
};

// A caller's abort reason passes through untouched; every other failure becomes a static code.
export function paymentFailure(error: unknown, phase: PaymentPhase): never {
  if (error instanceof PaymentError) throw error;
  if (!(error instanceof UptoError)) throw error;
  throw new PaymentError(
    (phase === PAYMENT_PHASES.SETTLE ? SETTLEMENT[error.code] : undefined) ??
      SHARED[error.code],
  );
}
