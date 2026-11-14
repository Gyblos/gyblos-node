// Per-frame ingress bounds and aggregate budgets for one duplex session, under the caller's absolute deadline.
import { batchFail } from '@gyblos/protocol/batch-channel';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { ControlFrameReader } from '@gyblos/protocol/control-framing';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  parseSessionBlock,
  type SessionBlockBinding,
} from '@gyblos/protocol/session-blocks';

import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

export type BlockStage = <T>(
  operation: Promise<T>,
  milliseconds: number,
  trackCompletion?: boolean,
) => Promise<T>;
export function blockBudget(maximum: number, initial = 0) {
  let bytes = initial;
  const consume = (added: number, reserve = 0) => {
    if (bytes + added + reserve > maximum)
      return batchFail(SESSION_CODES.LIMIT);
    bytes += added;
  };
  return Object.assign(consume, { remaining: () => maximum - bytes });
}
export function matchBlockBinding(
  row: SessionBlockBinding & { index: number },
  expected: SessionBlockBinding,
  index: number,
) {
  if (
    row.channelId !== expected.channelId ||
    row.requestId !== expected.requestId ||
    row.requestDigest !== expected.requestDigest ||
    row.index !== index
  )
    return batchFail(SESSION_CODES.BINDING);
}
export async function readSessionBlock(
  stream: ControlStream,
  maximum: number,
  check: () => void,
  stage: BlockStage,
  firstByteMs: number,
) {
  if (maximum < 1) return batchFail(SESSION_CODES.LIMIT);
  const first = await stage(stream.recv.read(1), firstByteMs);
  check();
  if (first.length !== 1) return batchFail();
  return stage(
    (async () => {
      const prefix = new Uint8Array(CONTROL_LIMITS.prefixBytes);
      prefix.set(first);
      prefix.set(
        await stream.recv.readExact(CONTROL_LIMITS.prefixBytes - 1),
        1,
      );
      check();
      const reader = new ControlFrameReader(maximum);
      reader.push(prefix); // Reject declared length before allocating or asking the socket for its body.
      const length = new DataView(prefix.buffer).getUint32(0);
      const body = await stream.recv.readExact(length);
      check();
      reader.push(Uint8Array.from(body));
      return parseSessionBlock(reader.finish());
    })(),
    IROH_DEADLINES.ingressMs,
  );
}
