// Reads session execution events under per-stage and absolute deadlines; EOF precedes any approval.
import {
  BATCH_CHANNEL,
  batchFail,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import {
  createBatchStreamVerifier,
  decodeBatchStreamEvent,
} from '@gyblos/protocol/batch-stream';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

export async function readBatchStreamResponse(
  stream: ControlStream,
  request: BatchChannelRequest,
  check: () => void,
  stage: <T>(operation: Promise<T>, milliseconds: number) => Promise<T>,
  onDelta: (text: string) => Promise<void>,
) {
  const verifier = await createBatchStreamVerifier(request);
  let bytes = 0;
  for (;;) {
    check();
    const prefix = Uint8Array.from(
      await stage(
        stream.recv.readExact(CONTROL_LIMITS.prefixBytes),
        IROH_DEADLINES.ingressMs,
      ),
    );
    check();
    const length = new DataView(prefix.buffer).getUint32(0);
    bytes += prefix.length + length;
    if (!length || bytes > BATCH_CHANNEL.responseBytes)
      return batchFail(SESSION_CODES.LIMIT);
    const frame = new Uint8Array(prefix.length + length);
    frame.set(prefix);
    frame.set(
      await stage(stream.recv.readExact(length), IROH_DEADLINES.ingressMs),
      prefix.length,
    );
    check();
    const accepted = await verifier.accept(decodeBatchStreamEvent(frame));
    check();
    if (accepted.delta !== undefined) {
      await stage(onDelta(accepted.delta), IROH_DEADLINES.egressMs);
      check();
    }
    if (accepted.terminal) {
      if ((await stage(stream.recv.read(1), IROH_DEADLINES.ingressMs)).length)
        return batchFail();
      check();
      verifier.finish();
      return accepted.terminal;
    }
  }
}
