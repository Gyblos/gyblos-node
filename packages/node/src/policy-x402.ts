// Adapts the existing per-request payment port to the common execution lifecycle.
// Admission and financial recovery remain separate from the engine and request cancellation.
import type { PaidSellerLedger } from '@gyblos/core/paid-admission';
import { paidCharge, paidOutputAllowance } from '@gyblos/core/paid-charge';
import type { ExecutionPolicy } from '@gyblos/protocol/execution-policy';
import {
  paidExecutionFail as fail,
  type PaidCharge,
  type PaidExecutionRequest,
  type PaidPayment,
} from '@gyblos/protocol/paid-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import type {
  PaymentAdmission,
  PaymentServer,
  PaymentTerms,
} from '@gyblos/protocol/payment';

import {
  admitDeposit,
  describeOwn,
  settleCharge,
  type PaidSettlementOptions,
} from './paid-settlement';

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
interface X402PolicyOptions {
  payment: PaymentServer;
  ledger: PaidSellerLedger;
  settlement: PaidSettlementOptions;
}
// Preserve invalid source metadata until the common window refuses it before opening the engine.
// Subtraction must never turn an unsafe claimUntil into a seemingly valid deadline.
function deadline(admission: PaymentAdmission, reserve: number) {
  return Number.isSafeInteger(admission.claimUntil) &&
    admission.claimUntil > 0 &&
    Number.isSafeInteger(reserve) &&
    reserve > 0
    ? admission.claimUntil - reserve
    : Number.NaN;
}

async function paymentTerms(
  request: PaidExecutionRequest,
  options: X402PolicyOptions,
): Promise<PaymentTerms> {
  const offer = request.quote.offer;
  const own = await describeOwn(options.payment, options.settlement);
  if (
    own.network !== offer.network ||
    own.mint !== offer.mint ||
    own.payTo !== offer.payTo ||
    own.feePayer !== offer.feePayer ||
    own.authorizer !== offer.authorizer
  )
    return fail(PAID_EXECUTION_CODES.UNSUPPORTED);
  return {
    ...own,
    buyer: offer.buyer,
    requestDigest: offer.requestDigest,
    maxAtomic: offer.maxAtomic,
    expiresAt: offer.expiresAt,
  };
}

export function createX402Policy(options: X402PolicyOptions): X402Policy {
  return {
    async admit(request, context) {
      const allowance = paidOutputAllowance(request, context.inputTokens);
      if (allowance === null) return fail(PAID_EXECUTION_CODES.LIMIT);
      const terms = await paymentTerms(request, options);
      const release = options.ledger.admit(request, context.now());
      try {
        context.ready();
        if (context.signal.aborted) return fail(PAID_EXECUTION_CODES.CANCELLED);
        const admission = await admitDeposit(
          options.payment,
          request,
          terms,
          context.signal,
          options.settlement,
        );
        return {
          outputTokens: allowance,
          deadline: deadline(admission, options.settlement.waitMs),
          state: { request, admission, release },
        };
      } catch (error) {
        release();
        throw error;
      }
    },
    async finish(permit, outcome) {
      const charge = paidCharge(
        permit.state.request,
        outcome,
        outcome.outputTokens > 0,
      );
      const payment = await settleCharge(
        options.payment,
        permit.state.admission,
        charge.chargedAtomic,
        options.settlement,
      );
      return { charge, payment };
    },
    release(permit) {
      permit.state.release();
    },
  };
}
