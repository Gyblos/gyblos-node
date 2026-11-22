// Executes a request on a verified open channel and records its approval before acknowledgement.
import {
  SESSION_CODES,
  sessionFail,
  type SessionBill,
  type SessionBuyer,
  type SessionRequest,
  type SessionVoucher,
} from '@gyblos/protocol/payment-session';

interface OpenedBatchBuyerExecution<T> {
  buyer: SessionBuyer;
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
export async function executeOpenedBatchBuyer<T>(
  dependencies: OpenedBatchBuyerExecution<T>,
  request: SessionRequest,
  signal: AbortSignal,
): Promise<T> {
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
