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

export const RENT_GUARDS = {
  ACCOUNT: 'Required transaction account missing.',
  SAFE_LAMPORTS: 'Unsafe lamport balance.',
  FRESH: 'A fresh escrow account is required.',
  FUNDED: 'Escrow account rent is required.',
  NONDECREASING: 'Escrow rent decreased between transactions.',
  CLOSED: 'The escrow account must be closed.',
  CREATION_COUNT: 'One canonical escrow creation is required.',
  CREATION_PROGRAM: 'Escrow creation must use the system program.',
  CREATION_PAYER: 'Escrow creation must be funded by the sponsor.',
  CREATION_OWNER: 'Escrow creation must assign the token program owner.',
  CREATION_SIZE: 'Escrow creation must use the canonical token account size.',
  CREATION_SAFE_AMOUNT: 'Escrow creation rent must be a positive safe integer.',
  CREATION_AMOUNT: 'Escrow creation rent must equal its funded balance.',
  CLOSURE_COUNT: 'One canonical escrow closure is required.',
  CLOSURE_PROGRAM: 'Escrow closure must use the token program.',
  CLOSURE_AUTHORITY: 'Escrow closure must be authorized by the channel.',
  CLOSURE_DESTINATION: 'Escrow closure rent must return to the sponsor.',
} as const;

export const TOKEN_GUARDS = {
  UNIQUE_ACCOUNT: 'Duplicate token account key.',
  BALANCE_ARRAY: 'Token balances must be an array.',
  UNIQUE_BALANCE: 'Duplicate token balance.',
  BALANCE_OWNER: 'Token balance owner must match the expected role.',
  BALANCE_MINT: 'Token balance mint must match the expected asset.',
  BALANCE_AMOUNT: 'Token balance must be an unsigned integer string.',
  TRANSFER_MINT: 'Token transfer mint must match the expected asset.',
  TRANSFER_AMOUNT: 'Token transfer must be an unsigned integer string.',
  CEILING_FORMAT: 'Token ceiling must be an unsigned integer string.',
  CEILING_POSITIVE: 'Token ceiling must be positive.',
  DISTINCT_ACCOUNTS:
    'Buyer, seller, escrow and treasury token accounts must be distinct.',
  DEPOSIT_SOURCE: 'Deposit tokens must come from the buyer ATA.',
  DEPOSIT_DESTINATION: 'Deposit tokens must go to the escrow ATA.',
  DEPOSIT_TOTAL: 'Deposit transfers must equal the original ceiling.',
  CLAIM_SOURCE: 'Claim tokens must come from the escrow ATA.',
  CLAIM_DESTINATION: 'Claim tokens must go to a canonical recipient ATA.',
  PRINCIPAL_TOTAL:
    'Charged plus refunded tokens must equal the original ceiling.',
  ESCROW_FRESH: 'Escrow must be empty before the deposit.',
  ESCROW_FUNDED: 'Escrow funding must equal the original ceiling.',
  PRINCIPAL: 'Escrow principal decreased.',
  ESCROW_EMPTY: 'Escrow must be empty after the claim.',
  SURPLUS: 'Treasury sweep must equal token surplus.',
  BUYER_DEPOSIT: 'Buyer deposit delta must equal the original ceiling.',
  SELLER_DEPOSIT: 'Seller balance must not change during deposit.',
  TREASURY_DEPOSIT: 'Treasury balance must not change during deposit.',
  BUYER_REFUND: 'Buyer claim delta must equal the refund.',
  SELLER_CHARGE: 'Seller claim delta must equal the charge.',
  TREASURY_DELTA: 'Treasury claim delta must equal the surplus sweep.',
} as const;

export const PROOF_GUARDS = {
  SIGNATURE_REQUIRED: 'A transaction signature is required.',
  TRANSACTION_AVAILABLE: 'Finalized transaction unavailable.',
  TRANSACTION_SUCCESS: 'Finalized transaction must have no error.',
  TRANSACTION_SLOT:
    'Finalized transaction slot must be a safe nonnegative integer.',
  TRANSACTION_SIGNATURE:
    'Finalized transaction signature must match the selected signature.',
  TRANSACTION_SPONSOR: 'Finalized transaction must use the expected sponsor.',
  TRANSACTION_FEE:
    'Finalized transaction fee must be a safe nonnegative integer.',
  CEILING_FORMAT: 'Proof ceiling must be an unsigned integer string.',
  CEILING_POSITIVE: 'Proof ceiling must be positive.',
  SIGNATURES_DISTINCT: 'Deposit and claim signatures must be distinct.',
  STATUS_COUNT: 'Every selected signature must have a status.',
  STATUS_AVAILABLE: 'Finalized signature unavailable.',
  STATUS_SUCCESS: 'Selected signature must have no error.',
  STATUS_FINALIZED: 'Selected signature must be finalized.',
  ORDER: 'Claim precedes deposit.',
  BUYER_SOL: 'Buyer SOL must not change in either selected transaction.',
  CHANNEL_FRESH: 'Channel must be unfunded before deposit.',
  CHANNEL_INTERVAL: 'Channel rent decreased between transactions.',
  CHANNEL_RETAINED: 'Retained channel lamports decreased during the claim.',
  DEPOSIT_SPONSOR:
    'Deposit sponsor delta must equal its fee plus channel and escrow rent.',
  CLAIM_SPONSOR:
    'Claim sponsor delta must equal its fee plus channel and escrow rent changes.',
  CHANNEL_CURRENT: 'Retained channel lamports decreased after the claim.',
  INITIAL_RENT: 'Initial channel rent is below minimum.',
} as const;

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

export type FinancialGuardMessage =
  | (typeof RENT_GUARDS)[keyof typeof RENT_GUARDS]
  | (typeof TOKEN_GUARDS)[keyof typeof TOKEN_GUARDS]
  | (typeof PROOF_GUARDS)[keyof typeof PROOF_GUARDS];
