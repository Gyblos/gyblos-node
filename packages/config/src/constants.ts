// Owns configuration labels and typed path failures shared with applications.
// Evidence, payment policy and lab orchestration do not belong here.
export const CONFIG_ASSET_LABELS = {
  DEVNET_USDC: 'devnet-usdc',
  TEST_TOKEN: 'devnet-test-token',
} as const;

export type ConfigAssetLabel =
  (typeof CONFIG_ASSET_LABELS)[keyof typeof CONFIG_ASSET_LABELS];

export const CONFIG_PATH_ERROR = {
  INVALID_WALLET_LIBRARY_ADDRESS: 'CONFIG_INVALID_WALLET_LIBRARY_ADDRESS',
} as const;
const PAYPAL_LIMIT_CENTS = 100;
const USD_CENTS_PER_DOLLAR = 100;
const PAYPAL_MESSAGE_CENTS = 10;
const PAYPAL_SESSION_MINUTES = 30;
const MILLISECONDS_PER_MINUTE = 60_000;
export const PAYPAL_SANDBOX_CURRENCIES = { USD: 'USD' } as const;
export const PAYPAL_SANDBOX = {
  currency: PAYPAL_SANDBOX_CURRENCIES.USD,
  price: (PAYPAL_LIMIT_CENTS / USD_CENTS_PER_DOLLAR).toFixed(2),
  limitCents: PAYPAL_LIMIT_CENTS,
  messageCents: PAYPAL_MESSAGE_CENTS,
  messagePrice: (PAYPAL_MESSAGE_CENTS / USD_CENTS_PER_DOLLAR).toFixed(2),
  maxMessageAttempts: 30,
  centsPerDollar: USD_CENTS_PER_DOLLAR,
  sessionMinutes: PAYPAL_SESSION_MINUTES,
  sessionMs: PAYPAL_SESSION_MINUTES * MILLISECONDS_PER_MINUTE,
  port: 8765,
  maxPort: 65535,
  ollamaOrigin: 'http://127.0.0.1:11434/',
} as const;
export const PAYPAL_CONFIG_ERROR = 'PAYPAL_CONFIG_INVALID';
