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
  SIGNATURE_PATTERN: /^[1-9A-HJ-NP-Za-km-z]{87,88}$/,
} as const;
export const BUYER_SIDECAR = {
  READY: 'buyer-ready',
  ERROR: 'buyer-error',
  STOP: 'buyer-stop',
} as const;
