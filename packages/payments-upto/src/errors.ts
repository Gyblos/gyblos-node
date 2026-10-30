// Translates x402-upto-metered failures into payment port codes. Admission and settlement map a few
// codes differently: a refused deposit is a mismatch, a lapsed or refused claim is unavailable.
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

const SETTLEMENT: Partial<Record<UptoErrorCode, PaymentErrorCode>> = {
  [UPTO_ERROR_CODES.FACILITATOR_REJECTED]: PAYMENT_ERROR_CODES.UNAVAILABLE,
};

export const PAYMENT_PHASES = { ADMIT: 'admit', SETTLE: 'settle' } as const;
type PaymentPhase = (typeof PAYMENT_PHASES)[keyof typeof PAYMENT_PHASES];

// A caller's abort reason passes through untouched; every other failure becomes a static code.
export function paymentFailure(error: unknown, phase: PaymentPhase): never {
  if (error instanceof PaymentError) throw error;
  if (!(error instanceof UptoError)) throw error;
  throw new PaymentError(
    (phase === PAYMENT_PHASES.SETTLE ? SETTLEMENT[error.code] : undefined) ??
      SHARED[error.code],
  );
}
