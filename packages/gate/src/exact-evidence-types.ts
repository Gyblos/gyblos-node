import type {
  PaymentRequired,
  SettleResponse,
  SupportedResponse,
} from '@x402/core/types';

import type {
  CASE_STATUSES,
  EXACT_CASES,
  EXACT_ENFORCEMENT,
  EXACT_REPLAY_SCOPE,
  EXACT_UNTRUSTED_CASES,
  FACILITATOR_STATUSES,
} from '@gyblos/gate/constants';
import type { GATE_ERROR_CODES } from '@gyblos/payments-x402/constants';
import type { PublicCall } from '@gyblos/payments-x402/exact/types';

import type { ExactEvidenceErrorCode } from './constants.js';
import type {
  AuthorizationMetadata,
  EvidenceBase,
  ExactSnapshot,
  Reconciliation,
} from './evidence-types.js';
import type { ChainTransaction } from './types.js';

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
      reason: typeof GATE_ERROR_CODES.INSUFFICIENT_EXACT_USDC;
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
      httpStatus: number;
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
      httpStatus: number;
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
  priceAtomic: string;
  startedAt: string;
  facilitators: FacilitatorObservation[];
  results: ExactCaseResult[];
  setupTransaction?: string;
  facilitatorUsed?: string;
  challenge?: PaymentRequired & { httpStatus: number };
  publicCalls?: PublicCall[];
  reconciliation?: Reconciliation;
  finishedAt?: string;
  error?: { code: ExactEvidenceErrorCode; name: string; message: string };
}
