// Harness-only vocabulary: evidence IDs and statuses, case names, funding operations and schema
// versions. Shared wallet, journal and guard values are imported from their owning packages.
import {
  ERROR_DIAGNOSTICS,
  INFERENCE_CASES,
  MEASUREMENT_SCHEMA_VERSION,
} from '@gyblos/buyer/constants';
import { LOCAL_DIR } from '@gyblos/config';
import {
  CONFIG_SCHEMA_VERSION,
  type ConfigAssetLabel,
} from '@gyblos/config/constants';
import { type ProtocolErrorCode } from '@gyblos/protocol/constants';

export const EXACT_PRICE = '10000';

export const PUBLIC_CALL_OUTCOMES = {
  SUCCESS: 'success',
  REJECTED: 'rejected',
  UNCERTAIN: 'uncertain',
} as const;

export const EXACT_EVIDENCE_CODES = {
  GATE_ERROR: 'GATE_ERROR',
} as const;

export const INFERENCE_EVIDENCE_CODES = {
  ASSERTION_FAILED: ERROR_DIAGNOSTICS.ASSERTION,
  EXECUTION_INTERRUPTED_OR_UNKNOWN: ERROR_DIAGNOSTICS.UNKNOWN,
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

export const FAILURE_CASES = {
  EMPTY_BUYER: 'F1',
  EXPIRED: 'F2',
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
  CONFIG: CONFIG_SCHEMA_VERSION,
  EVIDENCE: 1,
  MEASUREMENT: MEASUREMENT_SCHEMA_VERSION,
} as const;

export const EXACT_REPLAY_SCOPE = 'same-process replay guard' as const;

export type ExactEvidenceErrorCode =
  | ProtocolErrorCode
  | (typeof EXACT_EVIDENCE_CODES)[keyof typeof EXACT_EVIDENCE_CODES];

export type InferenceEvidenceErrorCode =
  | ProtocolErrorCode
  | (typeof INFERENCE_EVIDENCE_CODES)[keyof typeof INFERENCE_EVIDENCE_CODES];

export type EvidenceStatus =
  (typeof EVIDENCE_STATUSES)[keyof typeof EVIDENCE_STATUSES];

export type ReconciliationClassification =
  (typeof RECONCILIATION_CLASSIFICATIONS)[keyof typeof RECONCILIATION_CLASSIFICATIONS];

export type ExactCaseName = (typeof EXACT_CASES)[keyof typeof EXACT_CASES];

export type InferenceCaseName =
  (typeof INFERENCE_CASES)[keyof typeof INFERENCE_CASES];

export type EvidenceId = (typeof EVIDENCE_IDS)[keyof typeof EVIDENCE_IDS];

export type EvidenceAssetLabel =
  | ConfigAssetLabel
  | (typeof EXACT_ASSET_LABELS)[keyof typeof EXACT_ASSET_LABELS];

export type FundingOperation =
  (typeof FUNDING_OPERATIONS)[keyof typeof FUNDING_OPERATIONS];

export type PublicCallOutcome =
  (typeof PUBLIC_CALL_OUTCOMES)[keyof typeof PUBLIC_CALL_OUTCOMES];

// Gate-only paths, entrypoints, routes, funding floors and public endpoints (formerly in @gyblos/config).
export const LOCK_PATH = `${LOCAL_DIR}/buyer.lock`;

export const JOURNAL_PATHS = {
  fixed: `${LOCAL_DIR}/attempt.json`,
  f1: `${LOCAL_DIR}/failure-F1-attempt.json`,
  f2: `${LOCAL_DIR}/failure-F2-attempt.json`,
  exact: `${LOCAL_DIR}/exact-attempt.json`,
  inference: `${LOCAL_DIR}/inference-attempt.json`,
} as const;

export const FAILED_REQUEST_PATH = `${LOCAL_DIR}/failed-request.json`;

export const CHALLENGE_EVIDENCE_PATH = `${LOCAL_DIR}/challenge-evidence.json`;

export const FAILURE_EVIDENCE_PATH = `${LOCAL_DIR}/failure-evidence.json`;

export const INFERENCE_TRANSPORT_PATH = `${LOCAL_DIR}/inference-last-transport.json`;

export const ENTRYPOINTS = {
  seller: 'lab/harness/scripts/seller.ts',
  facilitator: 'apps/facilitator/src/main.ts',
} as const;

export const JOURNAL_FILENAMES = {
  exact: 'exact-attempt.json',
  inference: 'inference-attempt.json',
} as const;

export const EVIDENCE_PATHS = {
  exact: 'lab/evidence/gate-0004.json',
  inference: 'lab/evidence/gate-0005.json',
} as const;

export const keyPath = (role: string) => `${LOCAL_DIR}/${role}.json`;

export function failureJournalPath(kind: string) {
  return `${LOCAL_DIR}/failure-${kind}-attempt.json`;
}

export function failureResultPath(kind: string) {
  return `${LOCAL_DIR}/failure-${kind}-result.json`;
}

export function fixedEvidencePath(timestamp: number) {
  return `${LOCAL_DIR}/evidence-${timestamp}.json`;
}

export function keyFilename(role: string) {
  return `${role}.json`;
}

export const MIN_FACILITATOR_LAMPORTS = 15_000_000n;

export const FIXED_MIN_FACILITATOR_LAMPORTS = 10_000_000n;

export const GATE_CASES = {
  billingInflation: 1.4,
  billingDeflation: 0.6,
} as const;

export const PUBLIC_FACILITATORS = [
  {
    url: 'https://x402.org/facilitator',
    feePayer: 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5',
  },
  {
    url: 'https://facilitator.payai.network',
    feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4',
  },
] as const;

export const PUBLIC_ORIGINS = { tokenizer: 'https://huggingface.co' } as const;

export const GATE_ROUTES = {
  fixed: '/api/generate',
  exact: '/api/exact',
  fixedDefinition: 'GET /api/generate',
  exactDefinition: 'GET /api/exact',
} as const;
