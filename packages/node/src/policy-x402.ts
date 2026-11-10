// Adapts the existing per-request payment port to the common execution lifecycle.
// Admission and financial recovery remain separate from the engine and request cancellation.
import type { PaidSellerLedger } from '@gyblos/core/paid-admission';
import type { ExecutionPolicy } from '@gyblos/protocol/execution-policy';
import type {
  PaidCharge,
  PaidExecutionRequest,
  PaidPayment,
} from '@gyblos/protocol/paid-execution';
import type { PaymentAdmission, PaymentServer } from '@gyblos/protocol/payment';

import type { PaidSettlementOptions } from './paid-settlement';

export interface X402AdmitContext {
  inputTokens: number;
  signal: AbortSignal;
  now: () => number;
  ready: () => void;
}
interface X402State {
  request: PaidExecutionRequest;
  admission: PaymentAdmission;
  release: () => void;
}
export interface X402Settlement {
  charge: PaidCharge;
  payment: PaidPayment;
}
export type X402Policy = ExecutionPolicy<
  PaidExecutionRequest,
  X402AdmitContext,
  X402State,
  X402Settlement
>;
export interface X402PolicyOptions {
  payment: PaymentServer;
  ledger: PaidSellerLedger;
  settlement: PaidSettlementOptions;
}
export function createX402Policy(
  _options: X402PolicyOptions,
): X402Policy | undefined {
  return undefined;
}
