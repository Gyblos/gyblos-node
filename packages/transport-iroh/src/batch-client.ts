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
} from '@gyblos/protocol/batch-channel';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import { ControlError } from '@gyblos/protocol/control-validation';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import type {
  BatchConnection,
  BatchDestination,
  BatchEndpoint,
} from './batch-client-types';
import { readBatchFrame } from './batch-io';
import { HTTP_OVER_IROH } from './constants';
import { controlDeadline } from './control-io';
import { withDeadline } from './deadline';
import { relayOnlyAllows } from './paths';

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
        .connect(state.destination, [...Buffer.from(BATCH_CHANNEL.alpn)])
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
async function requestReply<Remote extends BatchDestination>(
  state: Context<Remote>,
  request: BatchChannelRequest,
  bytes: Uint8Array,
  signal: AbortSignal,
  beforeWrite: () => void,
) {
  const current = await connect(state, signal);
  const stream = await track(state, current.openBi());
  route(state, current, signal);
  if (
    request.method === BATCH_METHODS.OPEN ||
    request.method === BATCH_METHODS.EXECUTE
  )
    validateOfferV2Time(
      request.params.quote.offer,
      (state.options.now ?? Date.now)(),
    );
  beforeWrite(); // Even a rejected write may have transmitted bytes.
  await track(state, stream.send.writeAll([...bytes]));
  route(state, current, signal);
  await track(state, stream.send.finish());
  route(state, current, signal);
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
async function exchange<Remote extends BatchDestination>(
  state: Context<Remote>,
  value: unknown,
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
    const request = parseBatchChannelRequest(value);
    const bytes = encodeControlFrame(request, BATCH_CHANNEL.requestBytes);
    return await controlDeadline(
      (signal) =>
        track(
          state,
          requestReply(state, request, bytes, signal, () => {
            sent = true;
          }),
        ),
      request.method === BATCH_METHODS.EXECUTE
        ? (state.options.requestMs ?? TRANSPORT_TIMEOUTS.requestMs)
        : (state.options.operationMs ?? BATCH_SESSION_DEFAULTS.operationMs),
      () => drop(state),
      source,
    );
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
    exchange: (value: unknown, signal?: AbortSignal) =>
      exchange(state, value, signal),
    async close() {
      state.lifetime.abort();
      drop(state);
    },
    async settled() {
      while (state.pending.size) await Promise.allSettled([...state.pending]);
    },
  };
}
