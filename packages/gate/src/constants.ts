import type { GateErrorCode } from '@gyblos/payments-x402/constants';

export const EXACT_EVIDENCE_CODES = {
  GATE_ERROR: 'GATE_ERROR',
} as const;

export const INFERENCE_EVIDENCE_CODES = {
  ASSERTION_FAILED: 'ASSERTION_FAILED',
  EXECUTION_INTERRUPTED_OR_UNKNOWN: 'EXECUTION_INTERRUPTED_OR_UNKNOWN',
} as const;

export const JOURNAL_STATES = {
  AUTHORIZATION_CREATED: 'authorization-created',
  RECONCILED: 'reconciled',
  VERIFIED: 'verified',
  RESOLVED_REJECTED: 'resolved-rejected',
  REJECTED: 'rejected',
  CONFIRMED: 'confirmed',
  UNCERTAIN: 'uncertain',
} as const;

export const EVIDENCE_STATUSES = {
  IN_PROGRESS: 'in-progress',
  PASSED: 'passed',
  BLOCKED: 'blocked',
  UNCERTAIN: 'uncertain',
  INCOMPLETE: 'incomplete',
} as const;

export const CASE_STATUSES = {
  PASSED: 'passed',
  REJECTED: 'rejected',
  EXTERNAL_UNAVAILABLE: 'external-unavailable',
} as const;

export const FACILITATOR_STATUSES = {
  UNAVAILABLE: 'unavailable',
} as const;

export const RECONCILIATION_CLASSIFICATIONS = {
  MATCHED: 'matching-transaction-observed',
  NOT_OBSERVED: 'no-matching-transaction-observed',
  UNAVAILABLE: 'reconciliation-unavailable',
} as const;

export const EXACT_CASES = {
  STARTUP: 'startup',
  UNTRUSTED_ASSET: 'untrusted-asset',
  UNTRUSTED_PAY_TO: 'untrusted-payTo',
  UNTRUSTED_FEE_PAYER: 'untrusted-feePayer',
  INSUFFICIENT_USDC: 'insufficient-usdc',
  PAID_REQUEST: 'paid-request',
  REPLAY: 'replay',
} as const;

export const INFERENCE_CASES = {
  HONEST_1: 'honest-1',
  HONEST_2: 'honest-2',
  HONEST_3: 'honest-3',
  OVERCHARGE: 'overcharge',
  UNDERCHARGE: 'undercharge',
  ENGINE_INTERRUPTED: 'engine-interrupted',
} as const;

export const FAILURE_CASES = {
  EMPTY_BUYER: 'F1',
  EXPIRED: 'F2',
} as const;

export const CONFIG_ASSET_LABELS = {
  DEVNET_USDC: 'devnet-usdc',
  TEST_TOKEN: 'devnet-test-token',
} as const;

export const EXACT_ASSET_LABELS = {
  CIRCLE_USDC: 'Circle devnet USDC',
} as const;

export const EXACT_ENFORCEMENT = {
  BUYER_PREFLIGHT: 'buyer-preflight',
} as const;

export const CHALLENGE_STAGES = {
  UNPAID: 'unpaid-challenge-only',
} as const;

export const EVIDENCE_IDS = {
  EXACT: 'GYB-GATE-0004',
  INFERENCE: 'GYB-GATE-0005',
} as const;

export const WALLET_ROLES = {
  BUYER: 'buyer',
  SELLER: 'seller',
  AUTHORIZER: 'authorizer',
  FACILITATOR: 'facilitator',
  MINT: 'mint',
} as const;

export const EXACT_UNTRUSTED_CASES = {
  asset: EXACT_CASES.UNTRUSTED_ASSET,
  payTo: EXACT_CASES.UNTRUSTED_PAY_TO,
  feePayer: EXACT_CASES.UNTRUSTED_FEE_PAYER,
} as const;

export const FUNDING_OPERATIONS = {
  AIRDROP: 'devnet-airdrop',
  TEST_ACCOUNTS: 'devnet-test-accounts',
  TEST_MINT: 'devnet-test-mint',
} as const;

export const SCHEMA_VERSIONS = {
  CONFIG: 1,
  EVIDENCE: 1,
  MEASUREMENT: 1,
} as const;

export const EXACT_REPLAY_SCOPE = 'same-process replay guard' as const;

export type ExactEvidenceErrorCode =
  | GateErrorCode
  | (typeof EXACT_EVIDENCE_CODES)[keyof typeof EXACT_EVIDENCE_CODES];

export type InferenceEvidenceErrorCode =
  | GateErrorCode
  | (typeof INFERENCE_EVIDENCE_CODES)[keyof typeof INFERENCE_EVIDENCE_CODES];

export type JournalState = (typeof JOURNAL_STATES)[keyof typeof JOURNAL_STATES];

export type EvidenceStatus =
  (typeof EVIDENCE_STATUSES)[keyof typeof EVIDENCE_STATUSES];

export type CaseStatus = (typeof CASE_STATUSES)[keyof typeof CASE_STATUSES];

export type ReconciliationClassification =
  (typeof RECONCILIATION_CLASSIFICATIONS)[keyof typeof RECONCILIATION_CLASSIFICATIONS];

export type ExactCaseName = (typeof EXACT_CASES)[keyof typeof EXACT_CASES];

export type InferenceCaseName =
  (typeof INFERENCE_CASES)[keyof typeof INFERENCE_CASES];

export type FailureCaseName =
  (typeof FAILURE_CASES)[keyof typeof FAILURE_CASES];

export type ConfigAssetLabel =
  (typeof CONFIG_ASSET_LABELS)[keyof typeof CONFIG_ASSET_LABELS];

export type EvidenceId = (typeof EVIDENCE_IDS)[keyof typeof EVIDENCE_IDS];

export type WalletRole = (typeof WALLET_ROLES)[keyof typeof WALLET_ROLES];

export type EvidenceAssetLabel =
  | ConfigAssetLabel
  | (typeof EXACT_ASSET_LABELS)[keyof typeof EXACT_ASSET_LABELS];

export type FundingOperation =
  (typeof FUNDING_OPERATIONS)[keyof typeof FUNDING_OPERATIONS];
