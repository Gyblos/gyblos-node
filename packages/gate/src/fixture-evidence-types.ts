import type { PaymentRequirements } from '@x402/core/types';

import type { runGate } from '@gyblos/application/gate';
import type { createFacilitator } from '@gyblos/payments-x402/facilitator';

export type FixedGateEvidence = Awaited<ReturnType<typeof runGate>> & {
  schemaVersion: number;
  status: string;
  createdAt: string;
  network: string;
  assetLabel: string;
  mint: string;
  upstreamCommit: string;
  sdkVersion: string;
  transactions: { open: string; claim: string };
  limitations: string[];
};

export interface ChallengeEvidence {
  schemaVersion: number;
  stage: string;
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
  case: 'F1' | 'F2';
  status: string;
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
  schemaVersion: number;
  createdAt: string;
  network: string;
  mint: string;
  assetLabel: string;
  setupTransaction: string;
  results: FailureCaseResult[];
  limitations: string[];
}
