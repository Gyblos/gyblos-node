// Emits bounded paid streaming events with backpressure: deltas, then the one terminal the caller's
// service returns after it settled. A terminal the wire refuses is never sent. It invokes only the
// supplied service and never knows engines, metering or payment code.
import { FREE_EXECUTION } from '@gyblos/protocol/constants';
import {
  paidExecutionFail as fail,
  paidExecutionDigest,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  encodePaidStreamEvent,
  paidStreamDeltas,
} from '@gyblos/protocol/paid-stream';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from '@gyblos/protocol/paid/constants';

export interface PaidExecutionService {
  // Resolves only once the charge was settled or recorded as pending, even when the signal
  // aborts: the buyer leaving stops generation, never settlement. It must bound its own
  // settlement wait (reporting the charge as pending), since the request lease is held until
  // it resolves.
  stream(
    value: unknown,
    peer: string,
    signal: AbortSignal,
    onDelta: (text: string) => Promise<void>,
  ): Promise<PaidExecutionResponse>;
}

export async function streamPaidResponse(
  request: PaidExecutionRequest,
  service: PaidExecutionService,
  peer: string,
  signal: AbortSignal,
  check: () => void,
  write: (frame: Uint8Array) => Promise<void>,
) {
  const header = {
    version: PAID_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await paidExecutionDigest(request),
  };
  let sequence = 0;
  let bytes = 0;
  let sealed = false;
  let outputBytes = 0;
  let emitting = false;
  async function send(event: unknown, maximum: number) {
    check();
    const frame = encodePaidStreamEvent(event);
    if (bytes + frame.length > maximum) return fail(PAID_EXECUTION_CODES.LIMIT);
    bytes += frame.length;
    await write(frame);
    check();
    sequence++;
  }
  const emit = async (text: string) => {
    if (sealed) return fail(PAID_EXECUTION_CODES.CANCELLED);
    if (emitting) return fail(PAID_EXECUTION_CODES.LIMIT);
    emitting = true;
    try {
      for (const chunk of paidStreamDeltas(text)) {
        outputBytes += new TextEncoder().encode(chunk).length;
        if (
          outputBytes > FREE_EXECUTION.outputBytes ||
          sequence >= PAID_STREAM.maxEvents - 1
        )
          return fail(PAID_EXECUTION_CODES.LIMIT);
        await send(
          {
            ...header,
            sequence,
            type: PAID_STREAM.events.DELTA,
            text: chunk,
          },
          PAID_STREAM.totalBytes - PAID_STREAM.terminalReserveBytes,
        );
      }
    } finally {
      emitting = false;
    }
  };
  let response: PaidExecutionResponse;
  try {
    response = await service.stream(request, peer, signal, emit);
  } finally {
    sealed = true;
  }
  await send(
    { ...header, sequence, type: PAID_STREAM.events.TERMINAL, response },
    PAID_STREAM.totalBytes,
  );
}
