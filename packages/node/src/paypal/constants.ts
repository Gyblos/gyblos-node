// PayPal Sandbox phases and limits; no payment operations run here.
export const PAYPAL_PHASE = {
  CREATING: 'creating',
  CREATED: 'created',
  AUTHORIZING: 'authorizing',
  EXECUTING: 'executing',
  CAPTURING: 'capturing',
  COMPLETED: 'completed',
  VOIDING: 'voiding',
  VOIDED: 'voided',
  CANCELLED: 'cancelled',
  REFUNDING: 'refunding',
  REFUNDED: 'refunded',
} as const;
export const PAYPAL_REQUEST_LIMITS = {
  maxTokens: 256,
  promptBytes: 8192,
} as const;
export const PAYPAL_AGENT_REQUEST_LIMITS = {
  maxTokens: 2048,
  maxRows: 128,
  maxTools: 64,
  protocolIdentifierCharacters: 256,
  metadataEntries: 32,
  metadataKeyCharacters: 128,
  metadataValueCharacters: 1024,
  bodyReadMs: 5_000,
  requestBytes: 262144,
  responseBytes: 262144,
  digestDomain: 'paypal-agent-request-v2:',
  idempotencyDigestDomain: 'paypal-agent-idempotency-v1:',
  idempotencyKeyCharacters: 128,
} as const;
export const PAYPAL_SESSION_PHASE = {
  CREATING: 'creating',
  CREATED: 'created',
  REVIEW: 'review',
  AUTHORIZING: 'authorizing',
  ACTIVE: 'active',
  EXECUTING: 'executing',
  MESSAGE_PENDING: 'message_pending',
  CAPTURING: 'capturing',
  COMPLETED: 'completed',
  VOIDING: 'voiding',
  VOIDED: 'voided',
  CANCELLED: 'cancelled',
} as const;
export const PAYPAL_SESSION_STATUS = {
  READY: 'ready',
  BLOCKED: 'blocked',
} as const;
export const PAYPAL_SESSION_REVIEW_DECISION = {
  WAIVE_UNCERTAIN: 'waive-uncertain',
} as const;
export const PAYPAL_SESSION_REVIEW_ACTOR = {
  LOCAL_OPERATOR: 'local-operator-attestation',
} as const;
export const PAYPAL_SESSION_REVIEW_ARCHIVE_VERSION = 1;
export const PAYPAL_VOID_EXCEPTION = {
  VERSION: 1,
  DECISION: 'sandbox-exception-accept-unknown-history',
  UNKNOWN: 'unknown',
  AUTHORIZATION_VOIDED: 'VOIDED',
  HISTORY_SOURCE: 'paypal-transaction-search',
  DECISION_SOURCE: 'founder-chat',
  DECISION_SCOPE: 'single-sandbox-authorization',
  MAX_HISTORY_EVENTS: 30,
} as const;
export const PAYPAL_SESSION_PREVIOUS_RECORD_VERSION = 2;
export const PAYPAL_SESSION_RECORD_VERSION = 3;
export const PAYPAL_SESSION_VARIABLE_RECORD_VERSION = 4;
export const PAYPAL_SESSION_JOURNAL_MAX_BYTES = 65536;
export const PAYPAL_REVIEW_ENVELOPE_MAX_BYTES = 1024;
export const PAYPAL_VOID_EXCEPTION_ENVELOPE_MAX_BYTES = 16384;
