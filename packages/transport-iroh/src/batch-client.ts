// Reuses one authenticated Iroh connection for financial RPC; never retries a prompt or signs usage.
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
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import type {
  BatchConnection,
  BatchDestination,
  BatchEndpoint,
} from './batch-client-types';
import { HTTP_OVER_IROH } from './constants';
import { controlDeadline, readControlFrame } from './control-io';
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
  requestMs?: number;
  operationMs?: number;
  relayOnly?: boolean;
  relayAllowed?: (origin: string) => boolean;
}
export function createBatchChannelClient<Remote extends BatchDestination>(
  endpoint: BatchEndpoint<Remote>,
  destination: Remote,
  sellerNodeId: string,
  options: BatchClientOptions = {},
) {
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let connection: BatchConnection | undefined;
  let active = false;
  const track = <T>(promise: Promise<T>) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };
  const drop = () => {
    connection?.close(HTTP_OVER_IROH.streamCloseCode, []);
    connection = undefined;
  };
  const route = (current: BatchConnection, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (
      current.remoteId().toString() !== sellerNodeId ||
      (options.relayOnly && !relayOnlyAllows(current))
    )
      throw new BatchChannelError(PAID_EXECUTION_CODES.PEER);
  };
  async function connect(signal: AbortSignal) {
    signal.throwIfAborted();
    const relay = destination.relayUrl();
    if (
      destination.id().toString() !== sellerNodeId ||
      (relay && !options.relayAllowed?.(relay)) ||
      (options.relayOnly && !relay)
    )
      throw new BatchChannelError(PAID_EXECUTION_CODES.PEER);
    if (!connection) {
      const connected = await track(
        endpoint
          .connect(destination, [...Buffer.from(BATCH_CHANNEL.alpn)])
          .then((value) => {
            if (signal.aborted) {
              value.close(HTTP_OVER_IROH.streamCloseCode, []);
              signal.throwIfAborted();
            }
            return value;
          }),
      );
      try {
        route(connected, signal);
      } catch (error) {
        connected.close(HTTP_OVER_IROH.streamCloseCode, []);
        throw error;
      }
      connection = connected;
      void connected.closed().then(
        () => {
          if (connection === connected) connection = undefined;
        },
        () => {
          if (connection === connected) connection = undefined;
        },
      );
    }
    route(connection, signal);
    return connection;
  }
  return {
    async exchange(value: unknown, external?: AbortSignal) {
      if (active) throw new BatchClientError(SESSION_CODES.BUSY, false);
      if (lifetime.signal.aborted)
        throw new BatchClientError(PAID_EXECUTION_CODES.CANCELLED, false);
      const request: BatchChannelRequest = parseBatchChannelRequest(value);
      const bytes = encodeControlFrame(request, BATCH_CHANNEL.requestBytes);
      const source = AbortSignal.any([
        lifetime.signal,
        ...(external ? [external] : []),
      ]);
      let sent = false;
      active = true;
      try {
        const response = await controlDeadline(
          (signal) =>
            track(
              (async () => {
                const current = await connect(signal);
                const stream = await track(current.openBi());
                route(current, signal);
                // Set before the first write: even a rejected write may have transmitted bytes.
                sent = true;
                await track(stream.send.writeAll([...bytes]));
                route(current, signal);
                await track(stream.send.finish());
                route(current, signal);
                const raw = await track(
                  readControlFrame(stream, BATCH_CHANNEL.responseBytes),
                );
                route(current, signal);
                const result = await matchBatchChannelResponse(raw, request);
                route(current, signal);
                return result;
              })(),
            ),
          request.method === BATCH_METHODS.EXECUTE
            ? (options.requestMs ?? TRANSPORT_TIMEOUTS.requestMs)
            : (options.operationMs ?? BATCH_SESSION_DEFAULTS.operationMs),
          drop,
          source,
        );
        return response;
      } catch (error) {
        drop();
        const failure = batchError(error);
        const code = source.aborted
          ? PAID_EXECUTION_CODES.CANCELLED
          : error instanceof ControlError &&
              error.code === CONTROL_CODES.CANCELLED
            ? PAID_EXECUTION_CODES.TIMEOUT
            : failure.code;
        throw new BatchClientError(code, sent, failure.remote);
      } finally {
        active = false;
      }
    },
    async close() {
      lifetime.abort();
      drop();
    },
    async settled() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
