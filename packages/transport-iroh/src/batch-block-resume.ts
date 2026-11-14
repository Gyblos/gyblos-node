// Recovery is a single bounded financial exchange. It cannot invoke execution or reconstruct response text.
import { batchError, batchFail } from '@gyblos/protocol/batch-channel';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  encodeSessionBlock,
  parseSessionBlock,
  SESSION_BLOCK_KINDS,
  type SessionBlockFrame,
} from '@gyblos/protocol/session-blocks';

import { matchBlockBinding, type BlockStage } from './batch-block-io';
import type { BatchChannelService } from './batch-server';
import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

export async function respondBlockApproval(
  value: unknown,
  stream: ControlStream,
  service: BatchChannelService,
  peer: string,
  signal: AbortSignal,
  check: () => void,
  stage: BlockStage,
) {
  const approval = parseSessionBlock(value);
  if (approval.kind !== SESSION_BLOCK_KINDS.APPROVAL) return batchFail();
  if (encodeSessionBlock(approval).length > CONTROL_LIMITS.requestBytes)
    return batchFail(SESSION_CODES.LIMIT);
  let response: SessionBlockFrame;
  try {
    check();
    if (!service.resumeBlock) return batchFail(SESSION_CODES.UNAVAILABLE);
    response = await service.resumeBlock(approval, peer, signal);
    matchBlockBinding(response, approval, approval.index);
    if (
      response.blockDigest !== approval.blockDigest ||
      response.cumulativeAtomic !== approval.voucher.maxClaimableAmount
    )
      return batchFail(SESSION_CODES.BINDING);
  } catch (error) {
    response = {
      version: approval.version,
      channelId: approval.channelId,
      requestId: approval.requestId,
      requestDigest: approval.requestDigest,
      index: approval.index,
      kind: SESSION_BLOCK_KINDS.FAILURE,
      code: batchError(error).code,
    };
  }
  check();
  await stage(
    stream.send.writeAll([...encodeSessionBlock(response)]),
    IROH_DEADLINES.egressMs,
  );
  check();
  await stage(stream.send.finish(), IROH_DEADLINES.egressMs);
  check();
}
