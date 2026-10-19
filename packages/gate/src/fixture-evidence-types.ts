import type { PaymentRequirements } from '@x402/core/types';

import type { runGate } from '@gyblos/application/gate';
import type {
  CASE_STATUSES,
  CHALLENGE_STAGES,
  ConfigAssetLabel,
  EVIDENCE_STATUSES,
  FAILURE_CASES,
  SCHEMA_VERSIONS,
} from '@gyblos/gate/constants';
import type { createFacilitator } from '@gyblos/payments-x402/facilitator';

export type FixedGateEvidence = Awaited<ReturnType<typeof runGate>> & {
  schemaVersion: typeof SCHEMA_VERSIONS.EVIDENCE;
  status: typeof EVIDENCE_STATUSES.PASSED;
  createdAt: string;
  network: string;
  assetLabel: ConfigAssetLabel;
  mint: string;
  upstreamCommit: string;
  sdkVersion: string;
  transactions: { open: string; claim: string };
  limitations: string[];
};

export interface ChallengeEvidence {
  schemaVersion: typeof SCHEMA_VERSIONS.EVIDENCE;
  stage: typeof CHALLENGE_STAGES.UNPAID;
  gatePassed: boolean;
  createdAt: string;
  upstreamCommit: string;
  sdkVersion: string;
  challenge: PaymentRequirements;
  resourceExecutions: number;
  settlements: number;
  note: string;
}

export interface FailureCaseResult {
  case: typeof FAILURE_CASES.EMPTY_BUYER | typeof FAILURE_CASES.EXPIRED;
  status: typeof CASE_STATUSES.PASSED;
  httpStatus: number;
  buyer: string;
  channelId: string;
  expiresAt: number | undefined;
  rejection: unknown;
  verifications: ReturnType<typeof createFacilitator>['verifications'];
  events: ReturnType<typeof createFacilitator>['events'];
  handlerCalls: number;
  before: { buyer: string; seller: string };
  after: { buyer: string; seller: string };
  channelExists: boolean;
  paymentTransactions: unknown[];
}

export interface FailureGateEvidence {
  schemaVersion: typeof SCHEMA_VERSIONS.EVIDENCE;
  createdAt: string;
  network: string;
  mint: string;
  assetLabel: ConfigAssetLabel;
  setupTransaction: string;
  results: FailureCaseResult[];
  limitations: string[];
}
