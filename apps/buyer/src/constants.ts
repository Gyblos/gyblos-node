// Buyer call outcomes, phases, journal states, proxy error codes, measurement schema version, call and
// proof bounds, error diagnostic codes and synthetic inference case names.
import { ROLE_FILES, TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { BUYER_SELECTION_FILE } from '@gyblos/node/buyer-init-constants';
import { BUYER_PAID_TIMEOUTS } from '@gyblos/node/constants';
import { JOURNAL_STATES } from '@gyblos/payments-x402/constants';
import type { ProtocolErrorCode } from '@gyblos/protocol/constants';
import { ROUTE_DISCREPANCY } from '@gyblos/transport-iroh/constants';

export const CHAT_COMMANDS = {
  NEW: '/new',
  EXIT: '/exit',
  SETTLE: '/settle',
} as const;
export const CHAT_TURN_STATUSES = {
  COMPLETE: 'complete',
  UNCERTAIN: 'uncertain',
  REJECTED: 'rejected',
} as const;
export const CHAT_INPUT_BYTES = 64_000;

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
// Why one seller dropped out of a selection; printed by the free buyer, never with addresses.
export const SELLER_FAILURE_PHASES = {
  IDENTITY: 'identity',
  CONNECT: 'connect',
  DISCOVERY: 'discovery',
  QUOTE: 'quote',
  TIMEOUT: 'timeout',
} as const;
export type SellerFailurePhase =
  (typeof SELLER_FAILURE_PHASES)[keyof typeof SELLER_FAILURE_PHASES];
export const SELLER_FAILURES = {
  LINE: 'FREE_BUYER_SELLER_FAILED',
  IDENTITY: 'SELLER_IDENTITY_UNVERIFIED',
  DISCOVERY: 'SELLER_DISCOVERY_REJECTED',
  UNKNOWN: 'SELLER_ERROR_UNKNOWN',
  nodeIdChars: 8,
} as const;
export const BUYER_SELECTION = {
  configFile: ROLE_FILES.buyerSelection,
  statsFile: 'selection-stats.json',
  maxConfigBytes: BUYER_SELECTION_FILE.maxBytes,
  maxSellers: 16,
  maxDecisions: 1024,
  snapshotMs: 10000,
  // How long quotes may race. A relay round trip to a distant seller took about 250 ms in the
  // first real test, so the default leaves room; selection.json `quoteWindowMs` overrides it.
  windowMs: 3000,
  minWindowMs: 100,
  // Well inside CONTROL_LIMITS.quoteLifetimeMs, so a quote that wins late is still fresh.
  maxWindowMs: 10_000,
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
  retryAfterHeader: 'retry-after',
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
// Shared paid-buyer refusals remain available through the buyer's existing entry.
export { PAID_BUYER_CODES, type PaidBuyerCode } from '@gyblos/node/constants';
// Paid reconciliation's exit codes: 0 when nothing blocks payments.
export const PAID_RECONCILE_EXIT = { FAILED: 1, OPEN: 2 } as const;
// Why paid reconciliation stopped, with what to fix; printed alone, never with paths or URLs.
export const PAID_RECONCILE_CODES = {
  NETWORK:
    'PAID_RECONCILE_NETWORK_MISMATCH: role.json rpcUrl must serve devnet',
  ROLE: 'PAID_RECONCILE_ROLE_INVALID: run `pnpm node:setup --role buyer` first',
  INCOMPLETE:
    'PAID_RECONCILE_INCOMPLETE: stop the paid buyer, check the RPC and the buyer home, then run again',
} as const;
// `pnpm buyer:withdraw:paid`: 2 while another run is needed (a claim window or grace period to wait
// out, or a transaction not yet confirmed); 1 when it failed or refused to sign for a channel.
export const PAID_WITHDRAW_EXIT = { FAILED: 1, AGAIN: 2 } as const;
// Why paid withdrawal stopped, with what to fix; printed alone, never with paths or URLs.
export const PAID_WITHDRAW_CODES = {
  NETWORK: 'PAID_WITHDRAW_NETWORK_MISMATCH: role.json rpcUrl must serve devnet',
  ROLE: 'PAID_WITHDRAW_ROLE_INVALID: run `pnpm node:setup --role buyer` first',
  INCOMPLETE:
    'PAID_WITHDRAW_INCOMPLETE: stop the paid buyer, check the RPC, the wallet SOL and the buyer home, then run again',
  REFUSED:
    'PAID_WITHDRAW_REFUSED: a journaled channel is not this buyer’s with its terms; nothing was signed for it',
  FAILED:
    'PAID_WITHDRAW_FAILED: a channel’s step failed (see its failure code); the others went on, run again later',
} as const;
// A deposit ceiling of zero: a free quote, or a selection.json that buys nothing.
export const isFreeAtomic = (maxAtomic: string) => maxAtomic === '0';
export const PAID_BUYER = {
  // The whole request, from selection to the seller's terminal.
  requestMs: BUYER_PAID_TIMEOUTS.requestMs,
  // Checking the settlement on chain and recording the outcome, once the terminal arrived.
  receiptMs: BUYER_PAID_TIMEOUTS.receiptMs,
  // On shutdown, how long a running paid request may finish its receipt and record.
  drainMs: 90000,
  // Outcomes for reconciliation, one JSON line each, in the buyer home.
  recordsFile: 'paid-records.jsonl',
  // Channels reconciliation resolved, one JSON line each, beside the records.
  reconciliationsFile: 'paid-reconciliations.jsonl',
  // Past this size the records file, and the reconciliations file, refuse new lines.
  recordsBytes: 1048576,
  // A paid buyer quotes paid sellers only; a free winner is skipped this many times at most.
  freeSkips: 8,
  // The JSON field that carries the payment summary in completions and errors.
  paymentField: 'gyblos_payment',
  observationHeader: 'x-gyblos-payment-observation',
  observationValue: '1',
  requestDigestField: 'gyblos_request_digest',
  // The endpoint's bearer token, private in the buyer home; OpenAI SDKs send it as their apiKey.
  tokenFile: 'api-token',
  tokenBytes: 32,
  // Those bytes as unpadded base64url.
  tokenChars: 43,
  // Random hex in the temporary name the token is written under before it is linked into place.
  stagedSuffixBytes: 8,
  // A larger file is not one this buyer wrote.
  tokenFileBytes: 256,
  authScheme: 'Bearer',
  // The header Anthropic SDKs carry their key in; Node lowercases incoming header names.
  apiKeyHeader: 'x-api-key',
} as const;
// The paid endpoint's HTTP deadline: the request, a stream still connecting, then the receipt check
// and the record, each within its own bound.
export const PAID_BUYER_HTTP_MS =
  PAID_BUYER.requestMs +
  TRANSPORT_TIMEOUTS.connectMs +
  2 * PAID_BUYER.receiptMs;
// Preserve the existing buyer entry for shared payment outcomes.
export { PAID_VERDICTS, type PaidVerdict } from '@gyblos/node/constants';
// The OpenAI-compatible subset the free buyer accepts, and the fixed reasons it gives for refusing one.
export * from './chat-constants';
// Why `buyer:free` could not start; printed after FREE_BUYER_CODES.CONFIG with a next step.
export const FREE_BUYER_STARTUP = {
  TELEMETRY_CONFIG: 'BUYER_TELEMETRY_CONFIG_INVALID',
  ROLE_MISSING: 'BUYER_ROLE_MISSING',
  ROLE_INVALID: 'BUYER_ROLE_INVALID',
  NOT_BUYER: 'BUYER_ROLE_NOT_BUYER',
  SELECTION_MISSING: 'SELECTION_CONFIG_MISSING',
  SELECTION_INVALID: 'SELECTION_CONFIG_INVALID',
  STATS_INVALID: 'SELECTION_STATS_INVALID',
  DISCOVERY_STATE: 'DISCOVERY_STATE_UNAVAILABLE',
  IDENTITY_STATE: 'IDENTITY_STATE_UNAVAILABLE',
  MAX_TOKENS: 'SELECTION_MAX_TOKENS_TOO_HIGH',
  REASONING: 'SELECTION_REASONING_UNSUPPORTED',
  NODE_KEY: 'BUYER_NODE_KEY_MISMATCH',
  PORT_IN_USE: 'BUYER_PORT_IN_USE',
  // Paid mode: the role's RPC, or the request's network or asset, is not the devnet test token.
  PAID_NETWORK: 'BUYER_PAYMENT_NETWORK_MISMATCH',
  // Paid mode recounts with the pinned public tokenizer, so only its model can be bought.
  PAID_MODEL: 'BUYER_PAID_MODEL_UNSUPPORTED',
  PAID_KEY: 'BUYER_WALLET_KEY_INVALID',
  TOKENIZER: 'BUYER_TOKENIZER_UNAVAILABLE',
  // Unreadable, or held by another buyer process.
  JOURNAL: 'BUYER_PAYMENT_JOURNAL_UNAVAILABLE',
  // The paid endpoint's token file is not a private regular file holding a token.
  PAID_TOKEN: 'BUYER_API_TOKEN_INVALID',
  UNKNOWN: 'BUYER_STARTUP_FAILED',
} as const;
export type FreeBuyerStartupReason =
  (typeof FREE_BUYER_STARTUP)[keyof typeof FREE_BUYER_STARTUP];

// Local HTTP terminal metadata; never changes a signed protocol record.
export const BUYER_EXECUTION_FIELD = 'gyblos_execution';

// The guided form uses this explicit marker to clear a nullable field without changing blank defaults.
export const BUYER_INIT_INPUT = { CLEAR: '-', EMPTY_LABEL: 'none' } as const;
export const BUYER_INIT_FLAGS = {
  ADVANCED: '--advanced',
  HELP: '--help',
} as const;
