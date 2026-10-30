// Reads bounded ordered paid streaming events, awaiting each consumer before accepting more bytes,
// and returns the verified terminal. Authentication, route checks and possible-send tracking
// remain with the paid client.
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import {
  paidExecutionFail as fail,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  createPaidStreamVerifier,
  decodePaidStreamEvent,
} from '@gyblos/protocol/paid-stream';
import {
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from '@gyblos/protocol/paid/constants';

import { IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';

export async function readPaidStreamResponse(
  stream: ControlStream,
  request: PaidExecutionRequest,
  check: () => void,
  stage: <T>(operation: Promise<T>, milliseconds: number) => Promise<T>,
  onDelta: (text: string) => Promise<void>,
): Promise<PaidExecutionResponse> {
  const verifier = await createPaidStreamVerifier(request);
  for (;;) {
    check();
    const prefix = Uint8Array.from(
      await stage(
        stream.recv.readExact(CONTROL_LIMITS.prefixBytes),
        IROH_DEADLINES.ingressMs,
      ),
    );
    // An oversized length is refused before any body is allocated or read.
    const length = new DataView(prefix.buffer).getUint32(0);
    if (!length) return fail();
    if (length > PAID_STREAM.eventBytes)
      return fail(PAID_EXECUTION_CODES.LIMIT);
    const frame = new Uint8Array(prefix.length + length);
    frame.set(prefix);
    frame.set(
      await stage(stream.recv.readExact(length), IROH_DEADLINES.ingressMs),
      prefix.length,
    );
    check();
    const accepted = await verifier.accept(decodePaidStreamEvent(frame));
    check();
    if (accepted.delta !== undefined) {
      await stage(onDelta(accepted.delta), IROH_DEADLINES.egressMs);
      check();
    }
    if (accepted.terminal) {
      // A terminal seals the stream; any further byte is invalid.
      if ((await stage(stream.recv.read(1), IROH_DEADLINES.ingressMs)).length)
        return fail();
      check();
      verifier.finish();
      return accepted.terminal;
    }
  }
}
