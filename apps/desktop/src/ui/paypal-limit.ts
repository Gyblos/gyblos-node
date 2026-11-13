// Resolves an editable display amount against the existing approved sandbox limit catalog.
import {
  PAYPAL_SANDBOX,
  PAYPAL_SANDBOX_LIMIT_OPTIONS,
} from '@gyblos/config/constants';

export function sessionLimitCents(value: string) {
  if (!/^\d+(?:\.0{1,2})?$/.test(value)) return null;
  const cents = Number(value) * PAYPAL_SANDBOX.centsPerDollar;
  return PAYPAL_SANDBOX_LIMIT_OPTIONS.find((limit) => limit === cents) ?? null;
}
