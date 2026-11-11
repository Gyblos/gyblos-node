// Ordered session-v3 execution events bind live output to the exact RPC; no financial effects or I/O.
import { batchChannelDigest } from './batch-channel-request';
import { matchBatchChannelResponse } from './batch-channel-response';
import type {
  BatchChannelRequest,
  BatchChannelResponse,
} from './batch-channel-types';
import { batchBoundary, batchFail } from './batch-channel-validation';
import { BATCH_CHANNEL, BATCH_METHODS, BATCH_STREAM } from './batch/constants';
import { canonicalJson } from './canonical';
import { CONTROL_LIMITS, FREE_EXECUTION } from './constants';
import { ControlFrameReader, encodeControlFrame } from './control-framing';
import {
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation';
import { freeExecutionText } from './free-execution-validation';
import { SESSION_CODES } from './payment-session';

export { BATCH_STREAM } from './batch/constants';
interface Header {
  version: typeof BATCH_CHANNEL.version;
  requestId: string;
  requestDigest: string;
  sequence: number;
}
type BatchStreamEvent = Header &
  (
    | { type: typeof BATCH_STREAM.events.DELTA; text: string }
    | { type: typeof BATCH_STREAM.events.TERMINAL; response: unknown }
  );
function parseBatchStreamEvent(value: unknown): BatchStreamEvent {
  return batchBoundary(() => {
    const delta =
      !!value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === BATCH_STREAM.events.DELTA;
    const row = controlObject(value, [
      'version',
      'requestId',
      'requestDigest',
      'sequence',
      'type',
      delta ? 'text' : 'response',
    ]);
    if (row.version !== BATCH_CHANNEL.version) return batchFail();
    const header = {
      version: BATCH_CHANNEL.version,
      requestId: controlHex(row.requestId, CONTROL_LIMITS.requestIdBytes),
      requestDigest: controlHex(row.requestDigest),
      sequence: controlInteger(row.sequence, 0, BATCH_STREAM.maxEvents - 1),
    };
    if (row.type === BATCH_STREAM.events.DELTA) {
      const text = freeExecutionText(row.text, BATCH_STREAM.deltaBytes);
      if (!text) return batchFail();
      return { ...header, type: BATCH_STREAM.events.DELTA, text };
    }
    if (row.type !== BATCH_STREAM.events.TERMINAL) return batchFail();
    return {
      ...header,
      type: BATCH_STREAM.events.TERMINAL,
      response: row.response,
    };
  });
}
export function encodeBatchStreamEvent(value: unknown) {
  return batchBoundary(() =>
    encodeControlFrame(
      parseBatchStreamEvent(value),
      BATCH_CHANNEL.responseBytes,
    ),
  );
}
export function decodeBatchStreamEvent(bytes: Uint8Array) {
  return batchBoundary(() => {
    const reader = new ControlFrameReader(BATCH_CHANNEL.responseBytes);
    reader.push(bytes);
    return parseBatchStreamEvent(reader.finish());
  });
}
export async function createBatchStreamVerifier(request: BatchChannelRequest) {
  if (request.method !== BATCH_METHODS.EXECUTE) return batchFail();
  const digest = await batchChannelDigest(request);
  let sequence = 0;
  let text = '';
  let bytes = 0;
  let ended = false;
  let failed = false;
  return {
    async accept(
      value: unknown,
    ): Promise<{ delta?: string; terminal?: BatchChannelResponse }> {
      if (ended || failed) return batchFail();
      try {
        const event = parseBatchStreamEvent(value);
        bytes +=
          new TextEncoder().encode(canonicalJson(event)).length +
          CONTROL_LIMITS.prefixBytes;
        if (bytes > BATCH_CHANNEL.responseBytes)
          return batchFail(SESSION_CODES.LIMIT);
        if (
          event.sequence !== sequence ||
          event.requestId !== request.requestId ||
          event.requestDigest !== digest
        )
          return batchFail(SESSION_CODES.BINDING);
        sequence++;
        if (event.type === BATCH_STREAM.events.DELTA) {
          if (sequence >= BATCH_STREAM.maxEvents)
            return batchFail(SESSION_CODES.LIMIT);
          text += event.text;
          if (
            new TextEncoder().encode(text).length > FREE_EXECUTION.outputBytes
          )
            return batchFail(SESSION_CODES.LIMIT);
          return { delta: event.text };
        }
        const terminal = await matchBatchChannelResponse(
          event.response,
          request,
        );
        if (
          !terminal.result ||
          !('value' in terminal.result) ||
          terminal.result.value.text !== text
        )
          return batchFail(SESSION_CODES.BINDING);
        ended = true;
        return { terminal };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    finish() {
      if (!ended || failed) {
        failed = true;
        return batchFail();
      }
    },
  };
}
