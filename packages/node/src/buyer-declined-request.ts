import {
  BATCH_METHODS,
  BatchChannelError,
} from '@gyblos/protocol/batch-channel';
import {
  SESSION_CODES,
  SESSION_STATES,
  type SessionRequest,
} from '@gyblos/protocol/payment-session';
import {
  BatchClientError,
  type BatchDestination,
} from '@gyblos/transport-iroh/batch-client';

import type { BuyerBatchContext } from './batch-buyer-types';

export class DeclinedChannelRequest extends BatchChannelError {
  constructor(readonly nodeId: string) {
    super(SESSION_CODES.REQUEST_DECLINED);
  }
}
export async function verifyDecline<Remote extends BatchDestination>(
  context: BuyerBatchContext<Remote>,
  request: SessionRequest,
  channelId: string,
  signal: AbortSignal,
  failure: unknown,
): Promise<never> {
  const { buyer } = context.options;
  if (
    !(
      failure instanceof BatchClientError &&
      failure.remote &&
      failure.sent &&
      (failure.code === SESSION_CODES.UNVERIFIED ||
        failure.code === SESSION_CODES.REQUEST_DECLINED)
    ) ||
    !buyer.releaseDeclined
  )
    throw failure;
  try {
    const result = await context.rpc(
      BATCH_METHODS.SNAPSHOT,
      { channelId },
      signal,
    );
    if (
      !('snapshot' in result) ||
      result.snapshot.state !== SESSION_STATES.OPEN ||
      result.snapshot.channelId !== channelId ||
      result.snapshot.reservedAtomic !== '0' ||
      result.snapshot.cumulativeAtomic !== buyer.snapshot().cumulativeAtomic
    )
      throw failure;
    await buyer.releaseDeclined(channelId, request);
  } catch {
    throw failure;
  }
  await context.options.onDeclined?.();
  throw new DeclinedChannelRequest(context.terms.sellerNodeId);
}
