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
