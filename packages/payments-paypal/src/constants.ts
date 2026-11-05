// Sandbox-only provider endpoints and request limits for the PayPal adapter.
import { PAYPAL_SANDBOX } from '@gyblos/config/constants';

export const PAYPAL_ORDER_STATUS = {
  CREATED: 'CREATED',
  PAYER_ACTION_REQUIRED: 'PAYER_ACTION_REQUIRED',
  APPROVED: 'APPROVED',
  COMPLETED: 'COMPLETED',
} as const;

export const PAYPAL_ORDER_INTENT = { AUTHORIZE: 'AUTHORIZE' } as const;
export const PAYPAL_AUTHORIZATION_STATUS = { CREATED: 'CREATED' } as const;

export const PAYPAL_API = {
  origin: 'https://api-m.sandbox.paypal.com',
  approvalHost: PAYPAL_SANDBOX.approvalHost,
  timeoutMs: 15_000,
  limitCents: PAYPAL_SANDBOX.limitCents,
  centsPerDollar: PAYPAL_SANDBOX.centsPerDollar,
  noContent: 204,
  price: {
    currency_code: PAYPAL_SANDBOX.currency,
    value: PAYPAL_SANDBOX.price,
  },
} as const;
