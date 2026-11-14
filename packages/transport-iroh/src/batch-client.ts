// Authenticated reusable-session RPC; no prompt retry, payment signing or seller selection.
import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  BatchChannelError,
  batchError,
  matchBatchChannelResponse,
  parseBatchChannelRequest,
  type BatchChannelCode,
  type BatchChannelRequest,
  type BatchExecutionRequest,
} from '@gyblos/protocol/batch-channel';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import { ControlError } from '@gyblos/protocol/control-validation';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  parseSessionBlock,
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
  type SessionBlockAck,
  type SessionBlockApproval,
} from '@gyblos/protocol/session-blocks';

import { readBatchBlocks } from './batch-block-client';
import type { BlockStage } from './batch-block-io';
import { recoverBlockStream } from './batch-block-resume-client';
import type { BatchBlockClient } from './batch-block-types';
import type {
  BatchConnection,
  BatchDestination,
  BatchEndpoint,
} from './batch-client-types';
import { readBatchFrame } from './batch-io';
import { readBatchStreamResponse } from './batch-stream-client';
import { HTTP_OVER_IROH } from './constants';
import { controlDeadline } from './control-io';
import { withDeadline } from './deadline';
import { relayOnlyAllows } from './paths';

export type { BatchBlockClient } from './batch-block-types';

export type {
  BatchConnection,
  BatchDestination,
  BatchEndpoint,
} from './batch-client-types';
export class BatchClientError extends BatchChannelError {
  constructor(
    code: BatchChannelCode,
    readonly sent: boolean,
    remote = false,
  ) {
    super(code, remote);
    this.name = 'BatchClientError';
  }
}
export interface BatchClientOptions {
  blocks?: boolean;
  // Trusted host guard, called synchronously immediately before the first prompt write.
  beforeExecute?(request: BatchExecutionRequest): void;
  now?: () => number;
  requestMs?: number;
  operationMs?: number;
  relayOnly?: boolean;
  relayAllowed?: (origin: string) => boolean;
}
interface Context<Remote extends BatchDestination> {
  endpoint: BatchEndpoint<Remote>;
  destination: Remote;
  sellerNodeId: string;
  options: BatchClientOptions;
  lifetime: AbortController;
  pending: Set<Promise<unknown>>;
  connection?: BatchConnection;
  active: boolean;
}
function track<T, Remote extends BatchDestination>(
  state: Context<Remote>,
  promise: Promise<T>,
) {
  state.pending.add(promise);
  void promise.then(
    () => state.pending.delete(promise),
    () => state.pending.delete(promise),
  );
  return promise;
}
function drop<Remote extends BatchDestination>(state: Context<Remote>) {
  state.connection?.close(HTTP_OVER_IROH.streamCloseCode, []);
  state.connection = undefined;
}
function route<Remote extends BatchDestination>(
  state: Context<Remote>,
  current: BatchConnection,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (
    current.remoteId().toString() !== state.sellerNodeId ||
    (state.options.relayOnly && !relayOnlyAllows(current))
  )
    throw new BatchChannelError(PAID_EXECUTION_CODES.PEER);
}
async function connect<Remote extends BatchDestination>(
  state: Context<Remote>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const relay = state.destination.relayUrl();
  if (
    state.destination.id().toString() !== state.sellerNodeId ||
    (relay && !state.options.relayAllowed?.(relay)) ||
    (state.options.relayOnly && !relay)
  )
    throw new BatchChannelError(PAID_EXECUTION_CODES.PEER);
  if (!state.connection) {
    let expired = false;
    const connecting = track(
      state,
      state.endpoint
        .connect(state.destination, [
          ...Buffer.from(
            state.options.blocks ? SESSION_BLOCKS.alpn : BATCH_CHANNEL.alpn,
          ),
        ])
        .then((value) => {
          try {
            if (expired)
              throw new BatchChannelError(PAID_EXECUTION_CODES.TIMEOUT);
            route(state, value, signal);
          } catch (error) {
            value.close(HTTP_OVER_IROH.streamCloseCode, []);
            throw error;
          }
          return value;
        }),
    );
    const connected = await withDeadline(
      connecting,
      TRANSPORT_TIMEOUTS.connectMs,
      () => {
        expired = true;
        drop(state);
      },
    ).catch((error) => {
      if (expired) throw new BatchChannelError(PAID_EXECUTION_CODES.TIMEOUT);
      throw error;
    });
    route(state, connected, signal);
    state.connection = connected;
    const forget = () => {
      if (state.connection === connected) state.connection = undefined;
    };
    void connected.closed().then(forget, forget);
  }
  route(state, state.connection, signal);
  return state.connection;
}
function stageIn<Remote extends BatchDestination>(
  state: Context<Remote>,
  signal: AbortSignal,
  owned = true,
): BlockStage {
  return (operation, milliseconds, trackCompletion = owned) => {
    const running = trackCompletion ? track(state, operation) : operation;
    return track(
      state,
      controlDeadline(
        () => running,
        milliseconds,
        () => drop(state),
        signal,
      ),
    );
  };
}
async function requestReply<Remote extends BatchDestination>(
  state: Context<Remote>,
  request: BatchChannelRequest,
  bytes: Uint8Array,
  signal: AbortSignal,
  beforeWrite: () => void,
  onDelta: (text: string) => Promise<void>,
  blocks?: BatchBlockClient,
) {
  const current = await connect(state, signal);
  const stream = await track(state, current.openBi());
  route(state, current, signal);
  if (
    request.method === BATCH_METHODS.PREPARE ||
    request.method === BATCH_METHODS.OPEN ||
    request.method === BATCH_METHODS.EXECUTE
  )
    validateOfferV2Time(
      request.params.quote.offer,
      (state.options.now ?? Date.now)(),
    );
  if (request.method === BATCH_METHODS.EXECUTE)
    state.options.beforeExecute?.(request.params);
  if (
    request.method === BATCH_METHODS.EXECUTE &&
    state.options.blocks &&
    !blocks
  )
    throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
  beforeWrite(); // Even a rejected write may have transmitted bytes.
  await track(state, stream.send.writeAll([...bytes]));
  route(state, current, signal);
  if (
    request.method === BATCH_METHODS.EXECUTE &&
    state.options.blocks &&
    blocks
  ) {
    return readBatchBlocks(
      stream,
      request,
      blocks,
      signal,
      () => route(state, current, signal),
      stageIn(state, signal),
      onDelta,
      bytes.length,
    );
  }
  await track(state, stream.send.finish());
  route(state, current, signal);
  if (request.method === BATCH_METHODS.EXECUTE)
    return readBatchStreamResponse(
      stream,
      request,
      () => route(state, current, signal),
      stageIn(state, signal, false),
      onDelta,
    );
  const raw = await track(
    state,
    readBatchFrame(stream, BATCH_CHANNEL.responseBytes, () =>
      route(state, current, signal),
    ),
  );
  route(state, current, signal);
  const result = await matchBatchChannelResponse(raw, request);
  route(state, current, signal);
  return result;
}
async function runOperation<T, Remote extends BatchDestination>(
  state: Context<Remote>,
  operation: (source: AbortSignal, markSent: () => void) => Promise<T>,
  external?: AbortSignal,
) {
  if (state.active) throw new BatchClientError(SESSION_CODES.BUSY, false);
  const source = AbortSignal.any([
    state.lifetime.signal,
    ...(external ? [external] : []),
  ]);
  let sent = false;
  state.active = true;
  try {
    source.throwIfAborted();
    return await operation(source, () => {
      sent = true;
    });
  } catch (error) {
    drop(state);
    const failure = batchError(error);
    const code = source.aborted
      ? PAID_EXECUTION_CODES.CANCELLED
      : error instanceof ControlError && error.code === CONTROL_CODES.CANCELLED
        ? PAID_EXECUTION_CODES.TIMEOUT
        : failure.code;
    throw new BatchClientError(code, sent, failure.remote);
  } finally {
    state.active = false;
  }
}
function exchange<Remote extends BatchDestination>(
  state: Context<Remote>,
  value: unknown,
  external?: AbortSignal,
  onDelta: (text: string) => Promise<void> = async () => {},
  blocks?: BatchBlockClient,
) {
  return runOperation(
    state,
    (source, markSent) => {
      const request = parseBatchChannelRequest(value);
      const bytes = encodeControlFrame(request, BATCH_CHANNEL.requestBytes);
      return controlDeadline(
        (signal) =>
          track(
            state,
            requestReply(
              state,
              request,
              bytes,
              signal,
              markSent,
              onDelta,
              blocks,
            ),
          ),
        request.method === BATCH_METHODS.EXECUTE
          ? (state.options.requestMs ?? TRANSPORT_TIMEOUTS.requestMs)
          : (state.options.operationMs ?? BATCH_SESSION_DEFAULTS.operationMs),
        () => drop(state),
        source,
      );
    },
    external,
  );
}
function resumeBlock<Remote extends BatchDestination>(
  state: Context<Remote>,
  value: SessionBlockApproval,
  external?: AbortSignal,
) {
  return runOperation(
    state,
    (source, markSent) =>
      controlDeadline(
        async (signal): Promise<SessionBlockAck> => {
          if (!state.options.blocks)
            throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
          const approval = parseSessionBlock(value);
          if (approval.kind !== SESSION_BLOCK_KINDS.APPROVAL)
            throw new BatchChannelError(SESSION_CODES.INVALID);
          const current = await connect(state, signal);
          const stream = await track(state, current.openBi());
          const check = () => route(state, current, signal);
          return recoverBlockStream(
            stream,
            approval,
            check,
            stageIn(state, signal),
            markSent,
          );
        },
        state.options.operationMs ?? BATCH_SESSION_DEFAULTS.operationMs,
        () => drop(state),
        source,
      ),
    external,
  );
}
export function createBatchChannelClient<Remote extends BatchDestination>(
  endpoint: BatchEndpoint<Remote>,
  destination: Remote,
  sellerNodeId: string,
  options: BatchClientOptions = {},
) {
  const state: Context<Remote> = {
    endpoint,
    destination,
    sellerNodeId,
    options,
    lifetime: new AbortController(),
    pending: new Set(),
    active: false,
  };
  return {
    resumeBlock: (approval: SessionBlockApproval, signal?: AbortSignal) =>
      resumeBlock(state, approval, signal),
    exchange: (
      value: unknown,
      signal?: AbortSignal,
      onDelta?: (text: string) => Promise<void>,
      blocks?: BatchBlockClient,
    ) => exchange(state, value, signal, onDelta, blocks),
    async close() {
      state.lifetime.abort();
      drop(state);
    },
    async settled() {
      while (state.pending.size) await Promise.allSettled([...state.pending]);
    },
  };
}
