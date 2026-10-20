export const GATE_ERROR_CODES = {
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  BAD_USAGE: 'BAD_USAGE',
  BUYER_BUSY: 'BUYER_BUSY',
  BUYER_DELTA: 'BUYER_DELTA',
  BUYER_GAS: 'BUYER_GAS',
  CHANNEL_NOT_DISTRIBUTED: 'CHANNEL_NOT_DISTRIBUTED',
  INSUFFICIENT_EXACT_USDC: 'INSUFFICIENT_EXACT_USDC',
  INSUFFICIENT_INFERENCE_ESCROW: 'INSUFFICIENT_INFERENCE_ESCROW',
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  MISSING_TRANSACTIONS: 'MISSING_TRANSACTIONS',
  NEEDS_CIRCLE_USDC: 'NEEDS_CIRCLE_USDC',
  NEEDS_SOL: 'NEEDS_SOL',
  NEEDS_TOKENS: 'NEEDS_TOKENS',
  NO_PUBLIC_FACILITATOR: 'NO_PUBLIC_FACILITATOR',
  PAID_REQUEST_FAILED: 'PAID_REQUEST_FAILED',
  PORT_BUSY: 'PORT_BUSY',
  PROGRAM_UNAVAILABLE: 'PROGRAM_UNAVAILABLE',
  PUBLIC_OUTCOME_UNCERTAIN: 'PUBLIC_OUTCOME_UNCERTAIN',
  PUBLIC_PROVIDERS_REJECTED: 'PUBLIC_PROVIDERS_REJECTED',
  RPC_ERROR: 'RPC_ERROR',
  RPC_HTTP: 'RPC_HTTP',
  SELLER_DELTA: 'SELLER_DELTA',
  SUPPORT_CHANGED: 'SUPPORT_CHANGED',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  TRANSACTION_UNKNOWN: 'TRANSACTION_UNKNOWN',
  UNCONFIRMED_INFERENCE_DEPOSIT: 'UNCONFIRMED_INFERENCE_DEPOSIT',
  UNRESOLVED_ATTEMPT: 'UNRESOLVED_ATTEMPT',
  UNRESOLVED_EXACT: 'UNRESOLVED_EXACT',
  UNSUPPORTED_TOKEN_INSTRUCTION: 'UNSUPPORTED_TOKEN_INSTRUCTION',
  UNTRUSTED_EXACT_TERMS: 'UNTRUSTED_EXACT_TERMS',
  UNTRUSTED_RECEIPT: 'UNTRUSTED_RECEIPT',
  UNTRUSTED_TERMS: 'UNTRUSTED_TERMS',
  WRONG_CLUSTER: 'WRONG_CLUSTER',
} as const;

export const PUBLIC_CALL_OPERATIONS = {
  VERIFY: 'verify',
  SETTLE: 'settle',
} as const;

export const PUBLIC_CALL_OUTCOMES = {
  SUCCESS: 'success',
  REJECTED: 'rejected',
  UNCERTAIN: 'uncertain',
} as const;

export const CHANNEL_GUARDS = {
  AVAILABLE: 'Finalized channel account unavailable.',
  ENCODING: 'Finalized channel account must use base64 encoding.',
  SIZE: 'Finalized channel account must have the canonical size.',
  LAMPORTS: 'Finalized channel lamports must be a safe nonnegative integer.',
  CANONICAL: 'Channel owner, layout or canonical PDA is invalid.',
  STATUS: 'Finalized channel must be distributed.',
  DEPOSIT: 'Finalized channel deposit must equal the original ceiling.',
  SETTLED: 'Finalized channel settlement must equal the observed charge.',
  BUYER: 'Finalized channel payer must match the expected buyer.',
  PAYEE: 'Finalized channel payee must match the sponsor.',
  RENT_PAYER: 'Finalized channel rent payer must match the sponsor.',
  AUTHORIZER: 'Finalized channel authorizer must match the expected signer.',
  MINT: 'Finalized channel mint must match the expected asset.',
  MINIMUM_SAFE: 'Minimum channel rent must be a safe nonnegative integer.',
  MINIMUM: 'Retained channel rent is below minimum.',
} as const;

export type GateErrorCode =
  (typeof GATE_ERROR_CODES)[keyof typeof GATE_ERROR_CODES];

export type PublicCallOperation =
  (typeof PUBLIC_CALL_OPERATIONS)[keyof typeof PUBLIC_CALL_OPERATIONS];
export type PublicCallOutcome =
  (typeof PUBLIC_CALL_OUTCOMES)[keyof typeof PUBLIC_CALL_OUTCOMES];

export type FinalizedChannelGuardMessage =
  (typeof CHANNEL_GUARDS)[keyof typeof CHANNEL_GUARDS];

export {
  DEVNET,
  DEVNET_GENESIS,
  CHANNEL_PROGRAM,
  DEVNET_USDC,
  UPSTREAM_COMMIT,
  MAX_ATOMIC,
  ACTUAL_ATOMIC,
} from '@gyblos/config';
