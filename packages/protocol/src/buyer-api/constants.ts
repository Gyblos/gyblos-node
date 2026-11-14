// Public local-buyer API names; these do not change the signed inference protocol.
export const BUYER_API = {
  STATUS_PATH: '/v1/gyblos/status',
  CHAT_PATH: '/v1/gyblos/chat',
  PAYMENT_FIELD: 'gyblos_payment',
  EXECUTION_FIELD: 'gyblos_execution',
  NEVER_SENT_FIELD: 'gyblos_never_sent',
  VERSION: 1,
  POLICY_CHANGED_STATUS: 412,
  POLICY_CHANGED_CODE: 'BUYER_POLICY_CHANGED',
  MAX_ATOMIC_DIGITS: 20,
  MAX_MODEL_LENGTH: 128,
  POLICY_PATTERN:
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ADDRESS_PATTERN: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
} as const;
export const BUYER_SIDECAR = {
  READY: 'buyer-ready',
  ERROR: 'buyer-error',
  STOP: 'buyer-stop',
} as const;

// Delegated credentials are distinct from the buyer's private operator credential.
export const BUYER_API_KEYS = {
  VERSION: 1,
  PATH: '/v1/gyblos/api-keys',
  TOKEN_PREFIX: 'gyb_',
  TOKEN_BYTES: 32,
  TOKEN_PATTERN: /^gyb_[A-Za-z0-9_-]{43}$/,
  DIGEST_PATTERN: /^[0-9a-f]{64}$/,
  MAX_KEYS: 32,
  MAX_NAME: 64,
  MAX_REQUEST_BYTES: 4096,
  MAX_RESPONSE_BYTES: 65536,
  MAX_BINDING: 128,
} as const;
export const BUYER_KEY_ACTION = { CREATE: 'create', REVOKE: 'revoke' } as const;
export const BUYER_KEY_CHARGE = {
  SETTLED: 'settled',
  APPROVED: 'approved',
} as const;
export type BuyerKeyCharge =
  (typeof BUYER_KEY_CHARGE)[keyof typeof BUYER_KEY_CHARGE];
export const BUYER_KEY_CODES = {
  INVALID: 'BUYER_KEY_INVALID',
  UNAUTHORIZED: 'BUYER_KEY_UNAUTHORIZED',
  REVOKED: 'BUYER_KEY_REVOKED',
  LIMIT: 'BUYER_KEY_LIMIT_REACHED',
  REVIEW: 'BUYER_KEY_NEEDS_REVIEW',
  CAPACITY: 'BUYER_KEY_CAPACITY',
} as const;
export type BuyerKeyCode =
  (typeof BUYER_KEY_CODES)[keyof typeof BUYER_KEY_CODES];
