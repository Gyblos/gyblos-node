// Executes one independently verified paid quote against one authenticated seller over the paid
// stream and returns the verified terminal, refusals and stops included, since those report the
// charge and its settlement. `sent` says the authorization may have reached the seller, so a
// deposit may exist; reconciling it belongs to the caller. Never selects sellers or signs payments.
import type { Connection, Endpoint, EndpointAddr } from '@number0/iroh';

import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { validateOfferV2Time } from '@gyblos/protocol/offer-v2';
import {
  PaidExecutionError,
  verifyPaidExecutionRequest,
  type PaidExecutionRequest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import { encodePaidExecutionRequest } from '@gyblos/protocol/paid-stream';
import {
  PAID_EXECUTION_CODES,
  PAID_STREAM,
  type PaidExecutionCode,
} from '@gyblos/protocol/paid/constants';

import { HTTP_OVER_IROH, IROH_DEADLINES } from './constants';
import { readPaidStreamResponse } from './paid-stream-client';
import { relayOnlyAllows } from './paths';

export class PaidClientError extends Error {
  constructor(
    readonly code: PaidExecutionCode,
    readonly sent: boolean,
    readonly remote = false,
  ) {
    super(code);
    this.name = 'PaidClientError';
  }
}

export interface PaidClientOptions {
  onDelta?: (text: string) => Promise<void>;
  now?: () => number;
  requestMs?: number;
  relayOnly?: boolean;
  relayAllowed?: (origin: string) => boolean;
}

interface PaidClientState {
  operation?: Promise<unknown>;
  pending: Promise<unknown>[];
  used: boolean;
  sent: boolean;
  connection?: Connection;
  lifetime: AbortController;
  reason: PaidExecutionCode;
}

function closeState(state: PaidClientState) {
  state.lifetime.abort();
  state.connection?.close(HTTP_OVER_IROH.streamCloseCode, []);
  state.connection = undefined;
}

async function stage<T>(
  operation: Promise<T>,
  milliseconds: number,
  state: PaidClientState,
): Promise<T> {
  state.pending.push(operation);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          closeState(state);
          reject(new PaidExecutionError(PAID_EXECUTION_CODES.TIMEOUT));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Peer {
  endpoint: Pick<Endpoint, 'id' | 'connect'>;
  remote: EndpointAddr;
  identity: { owner: string; nodeId: string };
  options: PaidClientOptions;
  authenticate: (value: unknown) => Promise<PaidExecutionRequest>;
}

async function connect(peer: Peer, state: PaidClientState, check: () => void) {
  const { remote, identity, options } = peer;
  const relay = remote.relayUrl();
  if (
    remote.id().toString() !== identity.nodeId ||
    (relay && !options.relayAllowed?.(relay)) ||
    (options.relayOnly && !relay)
  )
    throw new PaidExecutionError(PAID_EXECUTION_CODES.PEER);
  const connecting = peer.endpoint
    .connect(remote, [...Buffer.from(PAID_STREAM.alpn)])
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
  return () => {
    check();
    if (
      connected.remoteId().toString() !== identity.nodeId ||
      (options.relayOnly && !relayOnlyAllows(connected))
    )
      throw new PaidExecutionError(PAID_EXECUTION_CODES.PEER);
  };
}

async function run(
  request: PaidExecutionRequest,
  peer: Peer,
  state: PaidClientState,
  check: () => void,
): Promise<PaidExecutionResponse> {
  const bytes = encodePaidExecutionRequest(request);
  check();
  const route = await connect(peer, state, check);
  route();
  await peer.authenticate(request);
  route();
  const connection = state.connection;
  if (!connection) throw new PaidExecutionError(PAID_EXECUTION_CODES.PEER);
  const stream = await stage(
    connection.openBi(),
    IROH_DEADLINES.egressMs,
    state,
  );
  route();
  // Opening a stream can take time; recheck zero-skew expiry right before transmission.
  await peer.authenticate(request);
  route();
  try {
    validateOfferV2Time(request.quote.offer, (peer.options.now ?? Date.now)());
  } catch {
    throw new PaidExecutionError(PAID_EXECUTION_CODES.EXPIRED);
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
  return readPaidStreamResponse(
    stream,
    request,
    route,
    (operation, milliseconds) => stage(operation, milliseconds, state),
    peer.options.onDelta ?? (async () => {}),
  );
}

function clientError(error: unknown, sent: boolean) {
  if (error instanceof PaidClientError) return error;
  if (!(error instanceof PaidExecutionError))
    return new PaidClientError(PAID_EXECUTION_CODES.INTERNAL, sent);
  return new PaidClientError(error.code, sent, error.remote);
}

export function createPaidExecutionClient(
  endpoint: Pick<Endpoint, 'id' | 'connect'>,
  remote: EndpointAddr,
  trust: { owner: string; nodeId: string },
  options: PaidClientOptions = {},
) {
  const now = options.now ?? Date.now;
  const identity = { ...trust };
  const state: PaidClientState = {
    pending: [],
    used: false,
    sent: false,
    lifetime: new AbortController(),
    reason: PAID_EXECUTION_CODES.CANCELLED,
  };
  const peer: Peer = {
    endpoint,
    remote,
    identity,
    options,
    authenticate: (value) =>
      verifyPaidExecutionRequest(value, {
        ...identity,
        remoteNodeId: endpoint.id().toString(),
        now: now(),
      }),
  };
  let cancelExecution: (() => void) | undefined;
  return {
    async execute(value: unknown, external?: AbortSignal) {
      if (state.used)
        throw new PaidClientError(PAID_EXECUTION_CODES.REPLAY, state.sent);
      state.used = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort = () => {};
      const check = () => {
        if (state.lifetime.signal.aborted)
          throw new PaidExecutionError(state.reason);
      };
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          closeState(state);
          reject(new PaidClientError(state.reason, state.sent));
        };
        external?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          state.reason = PAID_EXECUTION_CODES.TIMEOUT;
          abort();
        }, options.requestMs ?? TRANSPORT_TIMEOUTS.requestMs);
      });
      cancelExecution = abort;
      try {
        if (external?.aborted) abort();
        const operation = (async () => {
          check();
          return run(await peer.authenticate(value), peer, state, check);
        })();
        state.operation = operation;
        return await Promise.race([operation, cancelled]);
      } catch (error) {
        throw clientError(error, state.sent);
      } finally {
        cancelExecution = undefined;
        clearTimeout(timer);
        external?.removeEventListener('abort', abort);
        closeState(state);
      }
    },
    close() {
      cancelExecution?.();
      closeState(state);
    },
    async settled() {
      await state.operation?.catch(() => undefined);
      await Promise.allSettled(state.pending);
    },
  };
}
