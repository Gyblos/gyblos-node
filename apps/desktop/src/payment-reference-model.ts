// Validates explicitly requested local payment references, separately from usage activity.
import { PAYPAL_PAYMENT_REFERENCE_KIND } from '@gyblos/node/constants';
import type { PaypalPaymentReference } from '@gyblos/node/paypal-payment-reference';
import { isPaypalId } from '@gyblos/protocol/paypal-payment';

import { activityId } from './activity-model';
import { DESKTOP_ACTIVITY } from './constants';

export type PaymentReferenceResult = {
  available: boolean;
  references: PaypalPaymentReference[];
};
export type { PaypalPaymentReference } from '@gyblos/node/paypal-payment-reference';
export function unavailablePaymentReferences(): PaymentReferenceResult {
  return { available: false, references: [] };
}
export function parsePaymentReferences(value: unknown): PaymentReferenceResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return unavailablePaymentReferences();
  const result = Object.fromEntries(Object.entries(value));
  if (
    Object.keys(result).sort().join(',') !== 'available,references' ||
    typeof result.available !== 'boolean' ||
    !Array.isArray(result.references) ||
    result.references.length > DESKTOP_ACTIVITY.MAX_SESSIONS
  )
    return unavailablePaymentReferences();
  const references: PaypalPaymentReference[] = [];
  for (const item of result.references) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      return unavailablePaymentReferences();
    const row = Object.fromEntries(Object.entries(item));
    const kind = Object.values(PAYPAL_PAYMENT_REFERENCE_KIND).find(
      (value) => value === row.kind,
    );
    if (
      Object.keys(row).sort().join(',') !== 'id,kind,sessionId' ||
      !activityId(row.sessionId) ||
      !kind ||
      !isPaypalId(row.id) ||
      references.some((reference) => reference.sessionId === row.sessionId)
    )
      return unavailablePaymentReferences();
    references.push({ sessionId: row.sessionId, kind, id: row.id });
  }
  return {
    available: result.available,
    references: result.available ? references : [],
  };
}
