// Drains native session I/O and checks cancellation between prefix, body and EOF; no policy.
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { ControlFrameReader } from '@gyblos/protocol/control-framing';

import type { ControlStream } from './control-io';
import { withDeadline } from './deadline';

export async function readBatchFrame(
  stream: ControlStream,
  maximum: number,
  check: () => void,
) {
  const reader = new ControlFrameReader(maximum);
  check();
  const prefix = Uint8Array.from(
    await stream.recv.readExact(CONTROL_LIMITS.prefixBytes),
  );
  check();
  reader.push(prefix);
  const length = new DataView(prefix.buffer).getUint32(0);
  const body = await stream.recv.readExact(length);
  check();
  reader.push(Uint8Array.from(body));
  const trailing = await stream.recv.read(1);
  check();
  reader.push(Uint8Array.from(trailing));
  return reader.finish();
}
export async function batchDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  cancel: () => void,
): Promise<T> {
  try {
    return await withDeadline(operation, milliseconds, cancel);
  } finally {
    await operation.catch(() => undefined);
  }
}
