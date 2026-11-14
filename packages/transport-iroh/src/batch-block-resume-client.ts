// A financial-only recovery stream resends an exact approval and verifies its bounded ACK and EOF.
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { BatchChannelError } from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  encodeSessionBlock,
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
  type SessionBlockApproval,
} from '@gyblos/protocol/session-blocks';

import {
  matchBlockBinding,
  readSessionBlock,
  type BlockStage,
} from './batch-block-io';
import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

export async function recoverBlockStream(
  stream: ControlStream,
  approval: SessionBlockApproval,
  check: () => void,
  stage: BlockStage,
  markSent: () => void,
) {
  check();
  markSent();
  await stage(
    stream.send.writeAll([...encodeSessionBlock(approval)]),
    IROH_DEADLINES.egressMs,
  );
  check();
  await stage(stream.send.finish(), IROH_DEADLINES.egressMs);
  const frame = await readSessionBlock(
    stream,
    SESSION_BLOCKS.frameBytes,
    check,
    stage,
    BATCH_SESSION_DEFAULTS.operationMs,
  );
  matchBlockBinding(frame, approval, approval.index);
  if (frame.kind === SESSION_BLOCK_KINDS.FAILURE)
    throw new BatchChannelError(frame.code, true);
  if (
    frame.kind !== SESSION_BLOCK_KINDS.ACK ||
    frame.blockDigest !== approval.blockDigest ||
    frame.cumulativeAtomic !== approval.voucher.maxClaimableAmount
  )
    throw new BatchChannelError(SESSION_CODES.BINDING);
  if ((await stage(stream.recv.read(1), IROH_DEADLINES.ingressMs)).length)
    throw new BatchChannelError(SESSION_CODES.INVALID);
  check();
  return frame;
}
