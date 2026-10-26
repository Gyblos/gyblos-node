// Defines bounded ordered streaming events around the unchanged free request and terminal response.
// It performs no I/O; authenticated transport, deadlines, admission and cancellation belong to callers.
import {
  CONTROL_LIMITS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_STREAM,
} from './constants.js';
import { ControlFrameReader, encodeControlFrame } from './control-framing.js';
import {
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation.js';
import {
  freeExecutionBoundary,
  freeExecutionFail,
  freeExecutionText,
} from './free-execution-validation.js';
import {
  freeExecutionDigest,
  matchFreeExecutionResponse,
  parseFreeExecutionRequest,
  parseFreeExecutionResponse,
  type FreeExecutionRequest,
  type FreeExecutionResponse,
  type FreeExecutionResult,
} from './free-execution.js';

interface FreeStreamHeader {
  version: typeof FREE_EXECUTION.version;
  requestId: string;
  requestDigest: string;
  sequence: number;
}
export type FreeStreamEvent = FreeStreamHeader &
  (
    | { type: typeof FREE_STREAM.events.DELTA; text: string }
    | {
        type: typeof FREE_STREAM.events.TERMINAL;
        response: FreeExecutionResponse;
      }
  );
export function parseFreeStreamEvent(value: unknown): FreeStreamEvent {
  return freeExecutionBoundary(() => {
    const input = controlObject(value, [
      'version',
      'requestId',
      'requestDigest',
      'sequence',
      'type',
      ...(value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === FREE_STREAM.events.DELTA
        ? ['text']
        : ['response']),
    ]);
    if (input.version !== FREE_EXECUTION.version)
      return freeExecutionFail(FREE_EXECUTION_CODES.VERSION);
    if (
      typeof input.sequence === 'number' &&
      input.sequence >= FREE_STREAM.maxEvents
    )
      return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
    const header = {
      version: FREE_EXECUTION.version,
      requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
      requestDigest: controlHex(input.requestDigest),
      sequence: controlInteger(input.sequence, 0, FREE_STREAM.maxEvents - 1),
    };
    if (input.type === FREE_STREAM.events.DELTA) {
      const text = freeExecutionText(input.text, FREE_STREAM.deltaBytes);
      if (!text.length) return freeExecutionFail();
      return { ...header, type: FREE_STREAM.events.DELTA, text };
    }
    if (input.type !== FREE_STREAM.events.TERMINAL) return freeExecutionFail();
    return {
      ...header,
      type: FREE_STREAM.events.TERMINAL,
      response: parseFreeExecutionResponse(input.response),
    };
  });
}
export function encodeFreeStreamEvent(value: unknown) {
  return freeExecutionBoundary(() =>
    encodeControlFrame(parseFreeStreamEvent(value), FREE_STREAM.eventBytes),
  );
}
export function decodeFreeStreamEvent(bytes: Uint8Array) {
  return freeExecutionBoundary(() => {
    const reader = new ControlFrameReader(FREE_STREAM.eventBytes);
    reader.push(bytes);
    return parseFreeStreamEvent(reader.finish());
  });
}
export function* freeStreamDeltas(text: string) {
  freeExecutionText(text, FREE_EXECUTION.outputBytes);
  let chunk = '';
  let bytes = 0;
  for (const character of text) {
    const size = new TextEncoder().encode(character).length;
    if (bytes + size > FREE_STREAM.deltaBytes) {
      yield chunk;
      chunk = '';
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk) yield chunk;
}
export async function createFreeStreamVerifier(value: FreeExecutionRequest) {
  const request = parseFreeExecutionRequest(value);
  const digest = await freeExecutionDigest(request);
  let sequence = 0;
  let text = '';
  let outputBytes = 0;
  let bytes = 0;
  let ended = false;
  let failed = false;
  return {
    async accept(
      value: unknown,
    ): Promise<{ delta?: string; result?: FreeExecutionResult }> {
      if (ended || failed) return freeExecutionFail();
      try {
        const event = parseFreeStreamEvent(value);
        bytes += encodeFreeStreamEvent(event).length;
        if (bytes > FREE_STREAM.totalBytes)
          return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
        if (
          event.sequence !== sequence ||
          event.requestId !== request.requestId ||
          event.requestDigest !== digest
        )
          return freeExecutionFail(FREE_EXECUTION_CODES.BINDING);
        sequence++;
        if (event.type === FREE_STREAM.events.DELTA) {
          outputBytes += new TextEncoder().encode(event.text).length;
          if (outputBytes > FREE_EXECUTION.outputBytes)
            return freeExecutionFail(FREE_EXECUTION_CODES.LIMIT);
          text += event.text;
          return { delta: event.text };
        }
        ended = true;
        const result = await matchFreeExecutionResponse(
          event.response,
          request,
        );
        if (result.text !== text)
          return freeExecutionFail(FREE_EXECUTION_CODES.BINDING);
        return { result };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    finish() {
      if (!ended || failed) {
        failed = true;
        return freeExecutionFail();
      }
    },
  };
}
