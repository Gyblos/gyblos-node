// Shared reusable-session orchestration for trusted buyer/seller hosts; no HTTP, SDK or wallet logic.
// Hosts authenticate peers and verify quote/input policy. A possibly sent prompt is never retried here.
import type { ExecutionOutcome } from '@gyblos/protocol/execution-policy';
import {
  SESSION_CODES,
  sessionFail,
  type SessionBill,
  type SessionBuyer,
  type SessionRequest,
  type SessionSeller,
  type SessionSnapshot,
  type SessionVoucher,
} from '@gyblos/protocol/payment-session';

import { runAdmittedExecution, type AdmittedExecution } from './execution';

export interface BatchBuyerExecution<T> {
  buyer: SessionBuyer;
  // Must enforce independent identity, authenticated peer, quote signature/digest/time, exact input,
  // capability and price policy, and the existing unresolved-payment barrier before any prompt.
  verify(signal: AbortSignal): Promise<void>;
  open(payload: string, signal: AbortSignal): Promise<SessionSnapshot>;
  execute(
    request: SessionRequest,
    signal: AbortSignal,
  ): Promise<{ value: T; bill: SessionBill }>;
  // Independently recompute the actual charge from received usage/content and the verified quote.
  verifyUsage(value: T, signal: AbortSignal): Promise<string>;
  accept(
    bill: SessionBill,
    voucher: SessionVoucher,
    signal: AbortSignal,
  ): Promise<void>;
}
export async function executeBatchBuyer<T>(
  dependencies: BatchBuyerExecution<T>,
  request: SessionRequest,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  await dependencies.verify(signal);
  signal.throwIfAborted();
  const opened = await dependencies.open(
    await dependencies.buyer.open(),
    signal,
  );
  if (opened.channelId !== dependencies.buyer.snapshot().channelId)
    sessionFail(SESSION_CODES.BINDING);
  signal.throwIfAborted();
  await dependencies.buyer.begin(request);
  // From here the host may have transmitted content. Failures retain the reservation; no retry.
  const response = await dependencies.execute(request, signal);
  signal.throwIfAborted();
  if (
    response.bill.requestId !== request.requestId ||
    response.bill.requestDigest !== request.requestDigest ||
    response.bill.maxAtomic !== request.maxAtomic
  )
    sessionFail(SESSION_CODES.BINDING);
  const verified = await dependencies.verifyUsage(response.value, signal);
  signal.throwIfAborted();
  const voucher = await dependencies.buyer.approve(response.bill, verified);
  // Cancelling a request does not revoke a signature already emitted or erase its obligation.
  await dependencies.accept(response.bill, voucher, signal);
  await dependencies.buyer.acknowledge(request.requestId);
  return response.value;
}
export interface BatchSellerExecution<T> {
  seller: SessionSeller;
  request: SessionRequest;
  peer: string;
  // Verify signed quote/input/selection, readiness and metering before the financial reservation.
  verify(): Promise<void>;
  outputTokens: number;
  deadline: number;
  now: () => number;
  signal: AbortSignal;
  errors: AdmittedExecution<string, SessionBill, T>['errors'];
  open: AdmittedExecution<string, SessionBill, T>['open'];
  nothing: ExecutionOutcome;
  charge(outcome: ExecutionOutcome): string;
}
export async function runBatchSellerExecution<T>(
  execution: BatchSellerExecution<T>,
) {
  await execution.verify();
  execution.signal.throwIfAborted();
  await execution.seller.reserve(execution.request, execution.peer);
  return runAdmittedExecution({
    ...execution,
    permit: {
      outputTokens: execution.outputTokens,
      deadline: execution.deadline,
      state: execution.request.requestId,
    },
    policy: {
      finish: (permit, outcome) =>
        execution.seller.finish(permit.state, execution.charge(outcome)),
      // The common lifecycle releases generation; a financial reservation survives until approval/close.
      release() {},
    },
  });
}
