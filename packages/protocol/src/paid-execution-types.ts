// Paid inference wire shapes only; execution, payment, metering and replay storage belong to callers.
import type { SignedOfferV2 } from './control-types';
import type {
  ExecutionInput,
  ExecutionResult,
  FreeExecutionStop,
  FreeExecutionTrust,
} from './free-execution-types';
import type { PAID_EXECUTION, PaidExecutionCode } from './paid/constants';
import type { PaymentAuthorization, PaymentSettlement } from './payment';

export interface PaidExecutionRequest {
  version: typeof PAID_EXECUTION.version;
  requestId: string;
  quote: SignedOfferV2;
  input: ExecutionInput;
  payment: PaymentAuthorization;
}

// Recounted tokens the seller charges for and the amount, at the quote's prices, capped at the
// deposited ceiling. Zero when nothing was delivered.
export interface PaidCharge {
  inputTokens: number;
  outputTokens: number;
  chargedAtomic: string;
}

// Present once a deposit was admitted: the settlement, a charge still being settled, or a claim the
// chain refused for good, so nothing was charged and the whole deposit returns to the buyer.
export type PaidPayment =
  | { settlement: PaymentSettlement; pending?: never; lapsed?: never }
  | {
      pending: {
        channelId: string;
        chargedAtomic: string;
        transaction: string | null;
      };
      settlement?: never;
      lapsed?: never;
    }
  | {
      lapsed: { channelId: string };
      settlement?: never;
      pending?: never;
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
    | { result: ExecutionResult; error?: never }
    | { error: PaidExecutionFailure; result?: never }
  );

export type PaidExecutionTrust = FreeExecutionTrust;
