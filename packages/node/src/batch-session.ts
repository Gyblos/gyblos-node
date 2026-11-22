// Shared reusable-session orchestration for trusted buyer/seller hosts; no HTTP, SDK or wallet logic.
// Hosts authenticate peers and verify quote/input policy. A possibly sent prompt is never retried here.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  runAdmittedExecution,
  type AdmittedExecution,
} from '@gyblos/inference';
import type { ExecutionOutcome } from '@gyblos/protocol/execution-policy';
import {
  SESSION_CODES,
  sessionFail,
  type SessionBill,
  type SessionRequest,
  type SessionSeller,
  type SessionSnapshot,
} from '@gyblos/protocol/payment-session';

import {
  executeOpenedBatchBuyer,
  type OpenedBatchBuyerExecution,
} from './batch-buyer-opened';

export interface BatchBuyerExecution<T> extends OpenedBatchBuyerExecution<T> {
  // Must enforce independent identity, authenticated peer, quote signature/digest/time, exact input,
  // capability and price policy, and the existing unresolved-payment barrier before any prompt.
  verify(signal: AbortSignal): Promise<void>;
  open(payload: string, signal: AbortSignal): Promise<SessionSnapshot>;
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
  return executeOpenedBatchBuyer(dependencies, request, signal);
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
    cancelOnAbort: true,
    permit: {
      outputTokens: execution.outputTokens,
      deadline: Math.min(
        execution.deadline,
        execution.seller.snapshot().expiresAt -
          BATCH_SESSION_DEFAULTS.operationMs,
      ),
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
