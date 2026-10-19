import type {
  PaymentRequired,
  SettleResponse,
  SupportedResponse,
} from '@x402/core/types';

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
      case: 'startup';
      facilitator: string;
      status: 'external-unavailable';
      reason: string;
    }
  | {
      case: `untrusted-${string}`;
      status: 'passed';
      signed: false;
      handlerCalls: number;
    }
  | {
      case: 'insufficient-usdc';
      status: 'passed';
      enforcement: 'buyer-preflight';
      reason: typeof GATE_ERROR_CODES.INSUFFICIENT_EXACT_USDC;
      signed: false;
      before: ExactSnapshot;
      after: ExactSnapshot;
      handlerDelta: 0;
      publicPaymentCalls: 0;
    }
  | {
      case: 'paid-request';
      facilitator: string;
      status: 'rejected';
      httpStatus: number;
      calls: PublicCall[];
      reconciliation: Reconciliation;
    }
  | (AuthorizationMetadata & {
      case: 'paid-request';
      status: 'passed';
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
      case: 'replay';
      status: 'passed';
      httpStatus: number;
      before: ExactSnapshot;
      after: ExactSnapshot;
      handlerDelta: 0;
      publicCallDelta: 0;
      originalTransaction: string;
      scope: 'same-process replay guard';
    };

export type FacilitatorObservation =
  | {
      url: string;
      feePayer: string;
      fetchedAt: string;
      httpStatus: number;
      supported: SupportedResponse;
    }
  | { url: string; status: 'unavailable'; reason: string };

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
