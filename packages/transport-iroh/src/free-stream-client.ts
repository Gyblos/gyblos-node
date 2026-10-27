// Reads bounded ordered streaming events, awaiting each consumer before accepting more bytes.
// Authentication, route checks and possible-send tracking remain with the shared free client.
import { CONTROL_LIMITS, FREE_STREAM } from '@gyblos/protocol/constants';
import type { FreeExecutionRequest } from '@gyblos/protocol/free-execution';
import {
  createFreeStreamVerifier,
  decodeFreeStreamEvent,
} from '@gyblos/protocol/free-stream';

import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

export async function readFreeStreamResponse(
  stream: ControlStream,
  request: FreeExecutionRequest,
  check: () => void,
  stage: <T>(operation: Promise<T>, milliseconds: number) => Promise<T>,
  onDelta: (text: string) => Promise<void>,
) {
  const verifier = await createFreeStreamVerifier(request);
  for (;;) {
    check();
    const prefix = Uint8Array.from(
      await stage(
        stream.recv.readExact(CONTROL_LIMITS.prefixBytes),
        IROH_DEADLINES.ingressMs,
      ),
    );
    // The single-frame reader rejects an oversized prefix before any body allocation/read.
    const length = new DataView(prefix.buffer).getUint32(0);
    if (!length || length > FREE_STREAM.eventBytes) {
      decodeFreeStreamEvent(prefix);
    }
    const frame = new Uint8Array(prefix.length + length);
    frame.set(prefix);
    frame.set(
      await stage(stream.recv.readExact(length), IROH_DEADLINES.ingressMs),
      prefix.length,
    );
    check();
    const accepted = await verifier.accept(decodeFreeStreamEvent(frame));
    check();
    if (accepted.delta !== undefined) {
      await stage(onDelta(accepted.delta), IROH_DEADLINES.egressMs);
      check();
    }
    if (accepted.result) {
      if ((await stage(stream.recv.read(1), IROH_DEADLINES.ingressMs)).length) {
        // A terminal seals the verifier; any additional event or byte is invalid.
        await verifier.accept({});
      }
      check();
      verifier.finish();
      return accepted.result;
    }
  }
}
