// Emits bounded free streaming events with backpressure under the enclosing stream's admission lease.
// It invokes only the supplied policy service and never knows engines or payment code.
import {
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_STREAM,
} from '@gyblos/protocol/constants';
import {
  freeExecutionDigest,
  freeExecutionFail,
  type FreeExecutionRequest,
  type FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';
import {
  encodeFreeStreamEvent,
  freeStreamDeltas,
} from '@gyblos/protocol/free-stream';

import type { FreeExecutionService } from './free-server';

export async function streamFreeResponse(
  request: FreeExecutionRequest,
  service: FreeExecutionService,
  peer: string,
  signal: AbortSignal,
  check: () => void,
  write: (frame: Uint8Array) => Promise<void>,
) {
  const header = {
    version: FREE_EXECUTION.version,
    requestId: request.requestId,
    requestDigest: await freeExecutionDigest(request),
  };
  let sequence = 0;
  let bytes = 0;
  let sealed = false;
  let outputBytes = 0;
  let emitting = false;
  async function send(event: unknown, maximum = FREE_STREAM.totalBytes) {
    check();
    const frame = encodeFreeStreamEvent(event);
    if (bytes + frame.length > maximum)
      return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
    bytes += frame.length;
    await write(frame);
    check();
    sequence++;
  }
  const emit = async (text: string) => {
    if (sealed) return freeExecutionFail(FREE_EXECUTION_CODES.CANCELLED);
    if (emitting) return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
    emitting = true;
    try {
      for (const chunk of freeStreamDeltas(text)) {
        outputBytes += new TextEncoder().encode(chunk).length;
        if (outputBytes > FREE_EXECUTION.outputBytes)
          return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
        if (sequence >= FREE_STREAM.maxEvents - 1)
          return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
        await send(
          {
            ...header,
            sequence,
            type: FREE_STREAM.events.DELTA,
            text: chunk,
          },
          FREE_STREAM.totalBytes - FREE_STREAM.terminalReserveBytes,
        );
      }
    } finally {
      emitting = false;
    }
  };
  let response: FreeExecutionResponse;
  try {
    response = service.stream
      ? await service.stream(request, peer, signal, emit)
      : { ...header, error: { code: FREE_EXECUTION_CODES.UNSUPPORTED } };
  } finally {
    sealed = true;
  }
  check();
  let terminal = {
    ...header,
    sequence,
    type: FREE_STREAM.events.TERMINAL,
    response,
  };
  try {
    const frame = encodeFreeStreamEvent(terminal);
    if (bytes + frame.length > FREE_STREAM.totalBytes)
      return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
  } catch {
    terminal = {
      ...terminal,
      response: { ...header, error: { code: FREE_EXECUTION_CODES.LIMIT } },
    };
  }
  await send(terminal);
}
