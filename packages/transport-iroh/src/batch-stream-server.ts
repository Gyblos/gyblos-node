// Publishes bounded session deltas followed by one existing RPC terminal; no engine/payment knowledge.
import {
  BATCH_CHANNEL,
  batchChannelDigest,
  batchChannelResponse,
  batchError,
  batchFail,
  type BatchChannelCode,
  type BatchChannelRequest,
  type BatchChannelResponse,
} from '@gyblos/protocol/batch-channel';
import {
  BATCH_STREAM,
  encodeBatchStreamEvent,
} from '@gyblos/protocol/batch-stream';
import { FREE_EXECUTION } from '@gyblos/protocol/constants';
import { paidStreamDeltas } from '@gyblos/protocol/paid-stream';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import type { BatchChannelService } from './batch-server';

type Write = (frame: Uint8Array) => Promise<void>;
interface StreamState {
  header: Pick<BatchChannelResponse, 'version' | 'requestId' | 'requestDigest'>;
  sequence: number;
  bytes: number;
  outputBytes: number;
  sealed: boolean;
  emitting?: Promise<void>;
}
function failure(
  state: StreamState,
  code: BatchChannelCode,
): BatchChannelResponse {
  return { ...state.header, error: { code } };
}
async function send(
  state: StreamState,
  event: unknown,
  maximum: number,
  check: () => void,
  write: Write,
) {
  check();
  const frame = encodeBatchStreamEvent(event);
  if (state.bytes + frame.length > maximum)
    return batchFail(SESSION_CODES.LIMIT);
  state.bytes += frame.length;
  await write(frame);
  check();
  state.sequence++;
}
async function emit(
  state: StreamState,
  text: string,
  check: () => void,
  write: Write,
) {
  if (state.sealed || state.emitting) return batchFail(SESSION_CODES.LIMIT);
  let drained = () => {};
  state.emitting = new Promise<void>((resolve) => {
    drained = resolve;
  });
  try {
    for (const chunk of paidStreamDeltas(text)) {
      if (state.sealed) return batchFail();
      state.outputBytes += new TextEncoder().encode(chunk).length;
      if (
        state.outputBytes > FREE_EXECUTION.outputBytes ||
        state.sequence >= BATCH_STREAM.maxEvents - 1
      )
        return batchFail(SESSION_CODES.LIMIT);
      await send(
        state,
        {
          ...state.header,
          sequence: state.sequence,
          type: BATCH_STREAM.events.DELTA,
          text: chunk,
        },
        BATCH_CHANNEL.responseBytes - BATCH_STREAM.errorReserveBytes,
        check,
        write,
      );
    }
  } finally {
    drained();
    state.emitting = undefined;
  }
}
function terminal(state: StreamState, response: BatchChannelResponse) {
  const header = {
    ...state.header,
    sequence: state.sequence,
    type: BATCH_STREAM.events.TERMINAL,
  };
  try {
    const frame = encodeBatchStreamEvent({ ...header, response });
    if (state.bytes + frame.length <= BATCH_CHANNEL.responseBytes) return frame;
  } catch {
    /* Escaped text can exceed its content-byte bound; send a static LIMIT instead. */
  }
  return encodeBatchStreamEvent({
    ...header,
    response: failure(state, SESSION_CODES.LIMIT),
  });
}
export async function streamBatchResponse(
  request: BatchChannelRequest,
  service: BatchChannelService,
  peer: string,
  signal: AbortSignal,
  check: () => void,
  write: Write,
  cancel: () => void,
) {
  const state: StreamState = {
    header: {
      version: BATCH_CHANNEL.version,
      requestId: request.requestId,
      requestDigest: await batchChannelDigest(request),
    },
    sequence: 0,
    bytes: 0,
    outputBytes: 0,
    sealed: false,
  };
  let response: BatchChannelResponse;
  try {
    response = await batchChannelResponse(
      request,
      await service.exchange(request, peer, signal, (text) =>
        emit(state, text, check, write),
      ),
    );
  } catch (error) {
    response = failure(state, batchError(error).code);
  } finally {
    state.sealed = true;
    if (state.emitting) {
      const pending = state.emitting;
      cancel();
      await pending;
    }
  }
  check();
  await write(terminal(state, response));
  check();
}
