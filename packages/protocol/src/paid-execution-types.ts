// Paid inference wire shapes only; execution, payment, metering and replay storage belong to callers.
import type { SignedOfferV2 } from './control-types';
import type {
  FreeExecutionRequest,
  FreeExecutionResult,
  FreeExecutionStop,
  FreeExecutionTrust,
} from './free-execution-types';
import type { PAID_EXECUTION, PaidExecutionCode } from './paid/constants';
import type { PaymentAuthorization, PaymentSettlement } from './payment';

export interface PaidExecutionRequest {
  version: typeof PAID_EXECUTION.version;
  requestId: string;
  quote: SignedOfferV2;
  input: FreeExecutionRequest['input'];
  payment: PaymentAuthorization;
}

// Recounted tokens the seller charges for and the amount, at the quote's prices, capped at the
// deposited ceiling. Zero when nothing was delivered.
export interface PaidCharge {
  inputTokens: number;
  outputTokens: number;
  chargedAtomic: string;
}

// Present once a deposit was admitted: the settlement, or a charge still being settled.
export type PaidPayment =
  | { settlement: PaymentSettlement; pending?: never }
  | {
      pending: {
        channelId: string;
        chargedAtomic: string;
        transaction: string | null;
      };
      settlement?: never;
    };

export type PaidExecutionFailure = {
  code: PaidExecutionCode;
} & FreeExecutionStop;

interface PaidExecutionReply {
  version: typeof PAID_EXECUTION.version;
  requestId: string;
  requestDigest: string;
  // Both present after a deposit, both absent when refused before one.
  charge?: PaidCharge;
  payment?: PaidPayment;
}
export type PaidExecutionResponse = PaidExecutionReply &
  (
    | { result: FreeExecutionResult; error?: never }
    | { error: PaidExecutionFailure; result?: never }
  );

export type PaidExecutionTrust = FreeExecutionTrust;
