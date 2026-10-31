// Sandbox-only provider endpoints and request limits for the PayPal adapter.
import { PAYPAL_SANDBOX } from '@gyblos/config/constants';

export const PAYPAL_API = {
  origin: 'https://api-m.sandbox.paypal.com',
  approvalHost: 'www.sandbox.paypal.com',
  timeoutMs: 15_000,
  noContent: 204,
  price: {
    currency_code: PAYPAL_SANDBOX.currency,
    value: PAYPAL_SANDBOX.price,
  },
} as const;
