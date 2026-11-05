// The paid buyer behind the same loopback chat endpoint: a completed result carries what it cost, a
// seller's stop or refusal carries its code and the payment summary, and every paid error answers
// whether the prompt certainly never left this process. No keys, RPC URLs or prompts reach a reply.
import { HTTP_STATUS } from '@gyblos/config';
import { PaidBuyerError } from '@gyblos/node/buyer-paid-error';
import {
  executeBuyerPaid,
  type PaidBuyerDependencies,
  type PaidBuyerOutcome,
} from '@gyblos/node/buyer-paid-execution';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import {
  PAID_EXECUTION_CODES,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import { PaidClientError } from '@gyblos/transport-iroh/paid-client';

import { FREE_BUYER_CODES, PAID_BUYER_CODES } from './constants';
import type { ChatErrorView } from './free-http';
import type { ChatPayment, ChatResult } from './free-sse';

// A paid request that ended in the seller's stop or refusal rather than a result.
export class PaidOutcomeError extends Error {
  constructor(
    readonly code: PaidExecutionCode,
    readonly outcome: PaidBuyerOutcome,
  ) {
    super(code);
    this.name = 'PaidOutcomeError';
  }
}

export function paidSummary(outcome: PaidBuyerOutcome): ChatPayment {
  const payment = outcome.terminal.payment;
  const settled = payment?.settlement;
  return {
    verdict: outcome.verdict,
    maxAtomic: outcome.authorization.maxAtomic,
    expectedAtomic: outcome.recount.chargedAtomic,
    chargedAtomic:
      settled?.chargedAtomic ??
      payment?.pending?.chargedAtomic ??
      (payment?.lapsed ? '0' : null),
    sellerAtomic: settled?.sellerAtomic ?? null,
    feeAtomic: settled?.feeAtomic ?? null,
    refundedAtomic: settled?.refundedAtomic ?? null,
    recorded: outcome.recorded,
  };
}

export function paidChat(dependencies: PaidBuyerDependencies) {
  const run = async (
    input: FreeExecutionBuildInput,
    signal: AbortSignal,
    onDelta?: (text: string, requestDigest?: string) => Promise<void>,
  ): Promise<ChatResult> => {
    const outcome = await executeBuyerPaid(
      input,
      dependencies,
      signal,
      onDelta,
    );
    const { result, error } = outcome.terminal;
    if (result) return { ...result, payment: paidSummary(outcome) };
    throw new PaidOutcomeError(error.code, outcome);
  };
  return {
    execute: (input: FreeExecutionBuildInput, signal: AbortSignal) =>
      run(input, signal),
    stream: run,
  };
}

const unavailable = (
  code: ChatErrorView['code'],
  neverSent: boolean,
): ChatErrorView => ({
  code,
  status:
    code === PAID_EXECUTION_CODES.TIMEOUT
      ? HTTP_STATUS.gatewayTimeout
      : HTTP_STATUS.serviceUnavailable,
  neverSent,
  stop: {},
});

// Paid errors only; anything else is left to the free answer.
export function classifyPaidError(error: unknown): ChatErrorView | undefined {
  if (error instanceof PaidOutcomeError)
    return {
      ...unavailable(error.code, false),
      stop: error.outcome.terminal.error ?? {},
      payment: paidSummary(error.outcome),
    };
  if (error instanceof PaidBuyerError) {
    if (error.code === PAID_BUYER_CODES.UNSUPPORTED)
      return {
        ...unavailable(error.code, true),
        status: HTTP_STATUS.badRequest,
      };
    if (error.code === PAID_BUYER_CODES.BUSY)
      return {
        ...unavailable(error.code, true),
        status: HTTP_STATUS.tooManyRequests,
      };
    return unavailable(error.code, true);
  }
  if (error instanceof PaidClientError)
    return unavailable(error.code, !error.sent && !error.remote);
  // Payment errors come from authorizing or reading the journal, before anything is sent.
  if (error instanceof PaymentError) return unavailable(error.code, true);
  // The paid request's own deadline; an open may have been sent by then.
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return {
      ...unavailable(FREE_BUYER_CODES.TIMEOUT, false),
      status: HTTP_STATUS.gatewayTimeout,
    };
  return undefined;
}
