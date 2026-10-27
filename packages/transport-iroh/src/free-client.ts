// Executes one independently verified free quote against one authenticated seller.
// Tracks possible prompt transmission conservatively; never selects sellers or enables payments.
import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import {
  CONTROL_LIMITS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_STREAM,
  type FreeExecutionCode,
} from '@gyblos/protocol/constants';
import {
  FreeExecutionError,
  matchFreeExecutionResponse,
  verifyFreeExecutionRequest,
  type FreeExecutionRequest,
} from '@gyblos/protocol/free-execution';
import {
  encodeFreeExecutionRequest,
  FreeExecutionResponseReader,
} from '@gyblos/protocol/free-execution-framing';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';

import { HTTP_OVER_IROH, IROH_DEADLINES, TRANSPORT_ROUTES } from './constants';
import type { ControlStream } from './control-io';
import { readFreeStreamResponse } from './free-stream-client';
import { selectedRoute } from './paths';

export class FreeClientError extends Error {
  constructor(
    readonly code: FreeExecutionCode,
    readonly sent: boolean,
    readonly remote = false,
  ) {
    super(code);
    this.name = 'FreeClientError';
  }
}
async function readResponse(
  stream: ControlStream,
  check: () => void,
  state: FreeClientState,
) {
  const reader = new FreeExecutionResponseReader();
  const prefix = Uint8Array.from(
    await stream.recv.readExact(CONTROL_LIMITS.prefixBytes),
  );
  check();
  reader.push(prefix);
  const size = new DataView(prefix.buffer).getUint32(0);
  reader.push(
    Uint8Array.from(
      await stage(stream.recv.readExact(size), IROH_DEADLINES.ingressMs, state),
    ),
  );
  check();
  if (
    (await stage(stream.recv.read(1), IROH_DEADLINES.ingressMs, state)).length
  )
    throw new FreeExecutionError(FREE_EXECUTION_CODES.INVALID);
  check();
  return reader.finish();
}
interface FreeClientOptions {
  onDelta?: (text: string) => Promise<void>;
  now?: () => number;
  requestMs?: number;
  relayOnly?: boolean;
  relayAllowed?: (origin: string) => boolean;
}
interface FreeClientState {
  operation?: Promise<unknown>;
  pending: Promise<unknown>[];
  used: boolean;
  sent: boolean;
  connection?: Connection;
  lifetime: AbortController;
}
async function runFreeRequest(
  request: FreeExecutionRequest,
  endpoint: Pick<Endpoint, 'id' | 'connect'>,
  remote: EndpointAddr,
  identity: { owner: string; nodeId: string },
  options: FreeClientOptions,
  state: FreeClientState,
  check: () => void,
  authenticate: (value: unknown) => Promise<FreeExecutionRequest>,
) {
  const bytes = encodeFreeExecutionRequest(request);
  check();
  const relay = remote.relayUrl();
  if (
    remote.id().toString() !== identity.nodeId ||
    (relay && !options.relayAllowed?.(relay)) ||
    (options.relayOnly && !relay)
  )
    throw new FreeExecutionError(FREE_EXECUTION_CODES.PEER);
  const connecting = endpoint
    .connect(remote, [
      ...Buffer.from(options.onDelta ? FREE_STREAM.alpn : FREE_EXECUTION.alpn),
    ])
    .then((connected) => {
      if (state.lifetime.signal.aborted) {
        connected.close(HTTP_OVER_IROH.streamCloseCode, []);
        check();
      }
      return connected;
    });
  const connected = await stage(
    connecting,
    TRANSPORT_TIMEOUTS.connectMs,
    state,
  );
  state.connection = connected;
  const route = () => {
    check();
    if (
      connected.remoteId().toString() !== identity.nodeId ||
      (options.relayOnly && selectedRoute(connected) !== TRANSPORT_ROUTES.RELAY)
    )
      throw new FreeExecutionError(FREE_EXECUTION_CODES.PEER);
  };
  route();
  await authenticate(request);
  route();
  const stream = await stage(
    connected.openBi(),
    IROH_DEADLINES.egressMs,
    state,
  );
  route();
  // Opening a stream can take time; validate zero-skew expiry immediately before transmission.
  await authenticate(request);
  route();
  // Authentication yields during crypto; resample time without awaiting before the first write.
  try {
    validateOfferV2Time(request.quote.offer, (options.now ?? Date.now)());
  } catch {
    throw new FreeExecutionError(FREE_EXECUTION_CODES.EXPIRED);
  }
  state.sent = true;
  await stage(
    (async () => {
      await stream.send.writeAll([...bytes]);
      route();
      await stream.send.finish();
      route();
    })(),
    IROH_DEADLINES.egressMs,
    state,
  );
  return readFreeResult(stream, request, route, state, options);
}
async function readFreeResult(
  stream: ControlStream,
  request: FreeExecutionRequest,
  route: () => void,
  state: FreeClientState,
  options: FreeClientOptions,
) {
  if (options.onDelta)
    return readFreeStreamResponse(
      stream,
      request,
      route,
      (operation, milliseconds) => stage(operation, milliseconds, state),
      options.onDelta,
    );
  const response = await readResponse(stream, route, state);
  const result = await matchFreeExecutionResponse(response, request);
  route();
  return result;
}
export function createFreeExecutionClient(
  endpoint: Pick<Endpoint, 'id' | 'connect'>,
  remote: EndpointAddr,
  trust: { owner: string; nodeId: string },
  options: FreeClientOptions = {},
) {
  const now = options.now ?? Date.now;
  const identity = { ...trust };
  const state: FreeClientState = {
    pending: [],
    used: false,
    sent: false,
    lifetime: new AbortController(),
  };
  const close = () => closeClientState(state);
  let cancelExecution: (() => void) | undefined;
  const authenticate = (value: unknown) =>
    authenticateFreeRequest(value, endpoint, identity, now);

  return {
    async execute(value: unknown, external?: AbortSignal) {
      if (state.used)
        throw new FreeClientError(FREE_EXECUTION_CODES.REPLAY, state.sent);
      state.used = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort = () => {};
      let reason: FreeExecutionCode = FREE_EXECUTION_CODES.CANCELLED;
      const check = () => {
        if (state.lifetime.signal.aborted) throw new FreeExecutionError(reason);
      };
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          close();
          reject(new FreeClientError(reason, state.sent));
        };
        external?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          reason = FREE_EXECUTION_CODES.TIMEOUT;
          abort();
        }, options.requestMs ?? TRANSPORT_TIMEOUTS.requestMs);
      });
      cancelExecution = abort;
      try {
        if (external?.aborted) abort();
        const operation = (async () => {
          check();
          return runFreeRequest(
            await authenticate(value),
            endpoint,
            remote,
            identity,
            options,
            state,
            check,
            authenticate,
          );
        })();
        state.operation = operation;
        return await Promise.race([operation, cancelled]);
      } catch (error) {
        throw clientError(error, state.sent);
      } finally {
        cancelExecution = undefined;
        clearTimeout(timer);
        external?.removeEventListener('abort', abort);
        close();
      }
    },
    close() {
      cancelExecution?.();
      close();
    },
    async settled() {
      await state.operation?.catch(() => undefined);
      await Promise.allSettled(state.pending);
    },
  };
}

function clientError(error: unknown, sent: boolean) {
  if (error instanceof FreeClientError) return error;
  return new FreeClientError(
    error instanceof FreeExecutionError
      ? error.code
      : FREE_EXECUTION_CODES.INTERNAL,
    sent,
    error instanceof FreeExecutionError && error.remote,
  );
}

function authenticateFreeRequest(
  value: unknown,
  endpoint: Pick<Endpoint, 'id'>,
  identity: { owner: string; nodeId: string },
  now: () => number,
) {
  return verifyFreeExecutionRequest(value, {
    ...identity,
    remoteNodeId: endpoint.id().toString(),
    now: now(),
  });
}

function closeClientState(state: FreeClientState) {
  state.lifetime.abort();
  state.connection?.close(HTTP_OVER_IROH.streamCloseCode, []);
  state.connection = undefined;
}
async function stage<T>(
  operation: Promise<T>,
  milliseconds: number,
  state: FreeClientState,
): Promise<T> {
  state.pending.push(operation);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          closeClientState(state);
          reject(new FreeExecutionError(FREE_EXECUTION_CODES.TIMEOUT));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
