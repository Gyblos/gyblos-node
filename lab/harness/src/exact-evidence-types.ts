// Evidence types for the exact gate (GYB-GATE-0004): per-case results and facilitator observations.
import type {
  PaymentRequired,
  SettleResponse,
  SupportedResponse,
} from '@x402/core/types';

import type { HTTP_STATUS } from '@gyblos/config';
import type { ChainTransaction } from '@gyblos/payments-x402/accounting/types';
import type { PROTOCOL_ERROR_CODES } from '@gyblos/protocol/constants';

import {
  type CASE_STATUSES,
  type EVIDENCE_IDS,
  type EXACT_ASSET_LABELS,
  type EXACT_CASES,
  type EXACT_ENFORCEMENT,
  type EXACT_PRICE,
  type EXACT_REPLAY_SCOPE,
  type EXACT_UNTRUSTED_CASES,
  type ExactEvidenceErrorCode,
  type FACILITATOR_STATUSES,
  type GATE_HTTP_STATUS,
} from './constants';
import type {
  AuthorizationMetadata,
  EvidenceBase,
  ExactSnapshot,
  Reconciliation,
} from './evidence-types';
import { type PublicCall } from './exact/types';

export type ExactCaseResult =
  | {
      case: typeof EXACT_CASES.STARTUP;
      facilitator: string;
      status: typeof CASE_STATUSES.EXTERNAL_UNAVAILABLE;
      reason: string;
    }
  | {
      case: (typeof EXACT_UNTRUSTED_CASES)[keyof typeof EXACT_UNTRUSTED_CASES];
      status: typeof CASE_STATUSES.PASSED;
      signed: false;
      handlerCalls: number;
    }
  | {
      case: typeof EXACT_CASES.INSUFFICIENT_USDC;
      status: typeof CASE_STATUSES.PASSED;
      enforcement: typeof EXACT_ENFORCEMENT.BUYER_PREFLIGHT;
      reason: typeof PROTOCOL_ERROR_CODES.INSUFFICIENT_EXACT_USDC;
      signed: false;
      before: ExactSnapshot;
      after: ExactSnapshot;
      handlerDelta: 0;
      publicPaymentCalls: 0;
    }
  | {
      case: typeof EXACT_CASES.PAID_REQUEST;
      facilitator: string;
      status: typeof CASE_STATUSES.REJECTED;
      httpStatus: number;
      calls: PublicCall[];
      reconciliation: Reconciliation;
    }
  | (AuthorizationMetadata & {
      case: typeof EXACT_CASES.PAID_REQUEST;
      status: typeof CASE_STATUSES.PASSED;
      httpStatus: typeof HTTP_STATUS.ok;
      receipt: SettleResponse;
      resource: unknown;
      before: ExactSnapshot;
      after: ExactSnapshot;
      handlerDelta: 1;
      calls: PublicCall[];
      transaction: string;
      explorer: string;
      onChain: {
        slot: number;
        accountKeys: ChainTransaction['transaction']['message']['accountKeys'];
        signatures: string[];
        meta: ChainTransaction['meta'];
      };
    })
  | {
      case: typeof EXACT_CASES.REPLAY;
      status: typeof CASE_STATUSES.PASSED;
      httpStatus: typeof GATE_HTTP_STATUS.conflict;
      before: ExactSnapshot;
      after: ExactSnapshot;
      handlerDelta: 0;
      publicCallDelta: 0;
      originalTransaction: string;
      scope: typeof EXACT_REPLAY_SCOPE;
    };

export type FacilitatorObservation =
  | {
      url: string;
      feePayer: string;
      fetchedAt: string;
      httpStatus: number;
      supported: SupportedResponse;
    }
  | {
      url: string;
      status: typeof FACILITATOR_STATUSES.UNAVAILABLE;
      reason: string;
    };

export interface ExactGateEvidence extends EvidenceBase {
  evidenceId: typeof EVIDENCE_IDS.EXACT;
  assetLabel: typeof EXACT_ASSET_LABELS.CIRCLE_USDC;
  priceAtomic: typeof EXACT_PRICE;
  startedAt: string;
  facilitators: FacilitatorObservation[];
  results: ExactCaseResult[];
  setupTransaction?: string;
  facilitatorUsed?: string;
  challenge?: PaymentRequired & {
    httpStatus: typeof HTTP_STATUS.paymentRequired;
  };
  publicCalls?: PublicCall[];
  reconciliation?: Reconciliation;
  finishedAt?: string;
  error?: { code: ExactEvidenceErrorCode; name: string; message: string };
}
