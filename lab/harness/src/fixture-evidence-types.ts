// Evidence types for the fixed-price, unpaid-challenge and F1/F2 failure gates.
import type { PaymentRequirements } from '@x402/core/types';

import type { DEVNET, HTTP_STATUS } from '@gyblos/config';
import { type ConfigAssetLabel } from '@gyblos/config/constants';
import type { createFacilitator } from '@gyblos/payments-x402/facilitator';

import type {
  CASE_STATUSES,
  CHALLENGE_STAGES,
  EVIDENCE_STATUSES,
  FAILURE_CASES,
  SCHEMA_VERSIONS,
} from './constants';
import { type runGate } from './gate';

export type FixedGateEvidence = Awaited<ReturnType<typeof runGate>> & {
  schemaVersion: typeof SCHEMA_VERSIONS.EVIDENCE;
  status: typeof EVIDENCE_STATUSES.PASSED;
  createdAt: string;
  network: typeof DEVNET;
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
  gatePassed: false;
  createdAt: string;
  upstreamCommit: string;
  sdkVersion: string;
  challenge: PaymentRequirements;
  resourceExecutions: 0;
  settlements: 0;
  note: string;
}

export interface FailureCaseResult {
  case: typeof FAILURE_CASES.EMPTY_BUYER | typeof FAILURE_CASES.EXPIRED;
  status: typeof CASE_STATUSES.PASSED;
  httpStatus: typeof HTTP_STATUS.paymentRequired;
  buyer: string;
  channelId: string;
  expiresAt: number | undefined;
  rejection: unknown;
  verifications: ReturnType<typeof createFacilitator>['verifications'];
  events: ReturnType<typeof createFacilitator>['events'];
  handlerCalls: 0;
  before: { buyer: string; seller: string };
  after: { buyer: string; seller: string };
  channelExists: false;
  paymentTransactions: unknown[];
}

export interface FailureGateEvidence {
  schemaVersion: typeof SCHEMA_VERSIONS.EVIDENCE;
  createdAt: string;
  network: typeof DEVNET;
  mint: string;
  assetLabel: ConfigAssetLabel;
  setupTransaction: string;
  results: FailureCaseResult[];
  limitations: string[];
}
