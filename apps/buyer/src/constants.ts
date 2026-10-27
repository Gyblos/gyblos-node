// Buyer call outcomes, phases, journal states, proxy error codes, measurement schema version, call and
// proof bounds, error diagnostic codes and synthetic inference case names.
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';
import type { ProtocolErrorCode } from '@gyblos/protocol/constants';
import { ROUTE_DISCREPANCY } from '@gyblos/transport-iroh/constants';

export const CALL_OUTCOMES = {
  CONFIRMED: JOURNAL_STATES.CONFIRMED,
  UNCERTAIN: JOURNAL_STATES.UNCERTAIN,
  REJECTED: JOURNAL_STATES.REJECTED,
  ROUTE_DISCREPANCY,
  CONFIRMED_ERROR: 'confirmed-payment-error',
} as const;

export const RECONCILED_ZERO_CHARGE = 'finalized-zero-charge' as const;

export const P2P_JOURNAL_STATES = {
  AUTHORIZED: 'authorized',
  CONFIRMED: JOURNAL_STATES.CONFIRMED,
  UNCERTAIN: JOURNAL_STATES.UNCERTAIN,
} as const;

export const CALL_PHASES = {
  REQUEST: 'request',
  RESPONSE: 'response',
  PROOF: 'payment-proof',
  SETTLEMENT: 'settlement-receipt',
  OBSERVATION: 'inference-observation',
  MEASUREMENT: 'measurement',
  METRICS: 'route-metrics',
  PERSISTENCE: 'call-record',
} as const;

export type P2pJournalState =
  (typeof P2P_JOURNAL_STATES)[keyof typeof P2P_JOURNAL_STATES];

export type CallOutcome = (typeof CALL_OUTCOMES)[keyof typeof CALL_OUTCOMES];

export type CallPhase = (typeof CALL_PHASES)[keyof typeof CALL_PHASES];

export const BUYER_PROXY_ERROR_CODES = {
  MALFORMED_JSON: 'MALFORMED_JSON',
} as const;

export const BUYER_SELECTION_CODES = {
  QUOTE_ONLY: 'SELECTED_SELLER_NOT_TRUSTED',
  V1_INCOMPATIBLE: 'QUOTE_REQUIRES_UNSUPPORTED_V2_EXECUTION',
  NO_OFFER: 'NO_ACCEPTABLE_CONTROL_OFFER',
  INVALID: 'INVALID_BUYER_SELECTION_CONFIG',
  AUTHORIZATION_REQUIRED: 'TRUSTED_SELECTION_REQUIRED',
  RECONCILE: 'AUTHORIZATION_OUTCOME_REQUIRES_RECONCILIATION',
  LIMIT: 'BUYER_SELECTION_LIMIT',
  DISCOVERY_STATE: 'BUYER_DISCOVERY_STATE_UNAVAILABLE',
  DISCOVERY_LIMIT: 'BUYER_DISCOVERY_LIMIT',
  IDENTITY_STATE: 'BUYER_IDENTITY_STATE_UNAVAILABLE',
  IDENTITY: 'BUYER_IDENTITY_UNAVAILABLE',
} as const;
export const BUYER_SELECTION = {
  configFile: 'selection.json',
  statsFile: 'selection-stats.json',
  maxConfigBytes: 65536,
  maxSellers: 16,
  maxDecisions: 1024,
  snapshotMs: 10000,
  windowMs: 300,
  conflictStatus: 409,
  requestIdCharacters: 128,
  endpointCharacters: 2048,
  directAddressCharacters: 256,
  directAddresses: 16,
  signatureHexCharacters: 128,
  randomRange: 0x100000000,
  cooldownMs: 30000,
} as const;

// Discovery replay metadata is separate from payment authorization journals and selection telemetry.
export const BUYER_DISCOVERY = {
  stateFile: 'discovery-state-v2.json',
  lockFile: 'discovery-state-v2.lock',
  schemaVersion: 1,
  defaultPages: 3,
  maxPages: 8,
  pageSize: 50,
  timeoutMs: 10000,
  maxStateBytes: 1048576,
  maxStateRows: 1024,
} as const;

export type BuyerProxyErrorCode =
  (typeof BUYER_PROXY_ERROR_CODES)[keyof typeof BUYER_PROXY_ERROR_CODES];

export const MEASUREMENT_SCHEMA_VERSION = 1;

// Synthetic call cases selectable by index on the buyer:call command line.
export const MINIMUM_REQUESTS = 3;

// Bound on the channel history read when locating a deposit for a proof.
export const MAX_CHANNEL_SIGNATURES = 10;

export const ERROR_DIAGNOSTICS = {
  ASSERTION: 'ASSERTION_FAILED',
  UNKNOWN: 'EXECUTION_INTERRUPTED_OR_UNKNOWN',
  ABORTED: 'REQUEST_ABORTED',
  TIMEOUT: 'REQUEST_TIMEOUT',
  RESPONSE_INVALID: 'RESPONSE_INVALID',
} as const;

export const INFERENCE_CASES = {
  HONEST_1: 'honest-1',
  HONEST_2: 'honest-2',
  HONEST_3: 'honest-3',
  OVERCHARGE: 'overcharge',
  UNDERCHARGE: 'undercharge',
  ENGINE_INTERRUPTED: 'engine-interrupted',
} as const;

export type ErrorDiagnosticCode =
  | ProtocolErrorCode
  | (typeof ERROR_DIAGNOSTICS)[keyof typeof ERROR_DIAGNOSTICS];

// Local non-streaming compatibility surface; execution wire codes stay protocol-owned.
export const FREE_BUYER = {
  completionObject: 'chat.completion',
  chunkObject: 'chat.completion.chunk',
  streamContentType: 'text/event-stream',
  streamDone: '[DONE]',
  errorType: 'gyblos_error',
  contentType: 'application/json',
  // Header the official OpenAI SDKs honor to skip their automatic retries.
  noRetryHeader: 'x-should-retry',
  requestMs: 180000,
  headerMs: 10000,
  headers: 16384,
} as const;
export const FREE_BUYER_CODES = {
  INVALID: 'FREE_BUYER_INVALID_REQUEST',
  UNAVAILABLE: 'FREE_BUYER_NO_OFFER',
  CONFIG: 'FREE_BUYER_CONFIGURATION_REQUIRED',
  BUSY: 'FREE_BUYER_BUSY',
  INTERNAL: 'FREE_BUYER_INTERNAL',
  TOO_LARGE: 'FREE_BUYER_REQUEST_TOO_LARGE',
  TIMEOUT: 'FREE_BUYER_TIMEOUT',
} as const;
export type FreeBuyerCode =
  (typeof FREE_BUYER_CODES)[keyof typeof FREE_BUYER_CODES];
// Why `buyer:free` could not start; printed after FREE_BUYER_CODES.CONFIG with a next step.
export const FREE_BUYER_STARTUP = {
  ROLE_MISSING: 'BUYER_ROLE_MISSING',
  ROLE_INVALID: 'BUYER_ROLE_INVALID',
  NOT_BUYER: 'BUYER_ROLE_NOT_BUYER',
  SELECTION_MISSING: 'SELECTION_CONFIG_MISSING',
  SELECTION_INVALID: 'SELECTION_CONFIG_INVALID',
  MAX_TOKENS: 'SELECTION_MAX_TOKENS_TOO_HIGH',
  REASONING: 'SELECTION_REASONING_UNSUPPORTED',
  NODE_KEY: 'BUYER_NODE_KEY_MISMATCH',
  PORT_IN_USE: 'BUYER_PORT_IN_USE',
  UNKNOWN: 'BUYER_STARTUP_FAILED',
} as const;
export type FreeBuyerStartupReason =
  (typeof FREE_BUYER_STARTUP)[keyof typeof FREE_BUYER_STARTUP];
