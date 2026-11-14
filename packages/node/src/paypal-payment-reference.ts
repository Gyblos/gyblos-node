// Projects a known local payment reference without provider I/O or journal mutation.
// Usage activity remains identifier-free; references are a separate explicit local view.
import {
  PAYPAL_PAYMENT_REFERENCE_KIND,
  PAYPAL_SESSION_PHASE,
} from './constants';
import { paypalSessionActivity } from './paypal-session-activity';
import type { PaypalSessionRecord } from './paypal-session-record';

export type PaypalPaymentReference = {
  sessionId: string;
  kind: (typeof PAYPAL_PAYMENT_REFERENCE_KIND)[keyof typeof PAYPAL_PAYMENT_REFERENCE_KIND];
  id: string;
};
export function paypalPaymentReference(
  record: PaypalSessionRecord | null,
  status: Parameters<typeof paypalSessionActivity>[1],
): PaypalPaymentReference | null {
  const activity = paypalSessionActivity(record, status);
  if (!record || !activity || activity.needsReview) return null;
  if (
    record.phase === PAYPAL_SESSION_PHASE.COMPLETED &&
    record.captureId &&
    activity.capturedCents !== null
  ) {
    return {
      sessionId: activity.id,
      kind: PAYPAL_PAYMENT_REFERENCE_KIND.CAPTURE,
      id: record.captureId,
    };
  }
  return record.authorizationId
    ? {
        sessionId: activity.id,
        kind: PAYPAL_PAYMENT_REFERENCE_KIND.AUTHORIZATION,
        id: record.authorizationId,
      }
    : null;
}
