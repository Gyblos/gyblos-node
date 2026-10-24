// Transfers one bounded control frame including EOF. No HTTP forwarding or policy lives here.
import type { BiStream } from '@number0/iroh';

import { CONTROL_CODES, CONTROL_LIMITS } from '@gyblos/protocol/constants';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';
import { ControlError, controlFail } from '@gyblos/protocol/control-validation';

export interface ControlStream {
  recv: Pick<BiStream['recv'], 'readExact' | 'read'>;
  send: Pick<BiStream['send'], 'writeAll' | 'finish'>;
}
export async function readControlFrame(stream: ControlStream, maximum: number) {
  const reader = new ControlFrameReader(maximum);
  const prefix = Uint8Array.from(
    await stream.recv.readExact(CONTROL_LIMITS.prefixBytes),
  );
  reader.push(prefix); // Reject declared size before requesting/allocating its body.
  const length = new DataView(prefix.buffer).getUint32(0);
  reader.push(Uint8Array.from(await stream.recv.readExact(length)));
  if ((await stream.recv.read(1)).length) return controlFail();
  return reader.finish();
}
export async function writeControlFrame(
  stream: ControlStream,
  value: unknown,
  maximum: number,
) {
  await stream.send.writeAll([...encodeControlFrame(value, maximum)]);
  await stream.send.finish();
}
// One absolute deadline covers ingress, policy/signing and egress; cancellation never returns late data.
export async function controlDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  cancel: () => void,
  external?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      cancel();
      reject(new ControlError(CONTROL_CODES.CANCELLED));
    };
    external?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(abort, milliseconds);
    if (external?.aborted) abort();
  });
  try {
    if (controller.signal.aborted) return controlFail(CONTROL_CODES.CANCELLED);
    return await Promise.race([run(controller.signal), cancelled]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', abort);
  }
}
