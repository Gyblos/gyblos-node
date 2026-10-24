// Executes control policy through caller-owned leases, on isolated Iroh streams; never forwards HTTP.
import type { Connection } from '@number0/iroh';

import { CONTROL_CODES, CONTROL_LIMITS } from '@gyblos/protocol/constants';
import type { ControlResponse } from '@gyblos/protocol/control-types';
import { controlFail } from '@gyblos/protocol/control-validation';

import { HTTP_OVER_IROH } from './constants.js';
import {
  controlDeadline,
  readControlFrame,
  writeControlFrame,
  type ControlStream,
} from './control-io.js';
import { handleIrohConnection } from './iroh-connection.js';

export interface ControlQueryLease {
  check(): void;
  publish<T>(value: T): T;
  cancel(): void;
}
export interface ControlService {
  queryMs: number;
  idleMs: number;
  open(peer: string): { beginQuery(): ControlQueryLease; close(): void };
  respond(
    value: unknown,
    peer: string,
    signal: AbortSignal,
  ): Promise<ControlResponse>;
}
export async function serveControlStream(
  stream: ControlStream,
  service: ControlService,
  session: ReturnType<ControlService['open']>,
  peer: string,
  close: () => void,
  external: AbortSignal,
  enter: () => (() => void) | undefined,
  routeAllowed: () => boolean = () => true,
) {
  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    close();
  };
  const release = enter(); // Endpoint budget precedes the independent per-ALPN budget.
  if (!release) {
    closeOnce();
    return;
  }
  let lease: ControlQueryLease | undefined;
  try {
    lease = session.beginQuery(); // Malformed and incomplete frames consume quota too.
    const admitted = lease;
    await controlDeadline(
      async (signal) => {
        const value = await readControlFrame(
          stream,
          CONTROL_LIMITS.requestBytes,
        );
        admitted.check();
        const response = await service.respond(value, peer, signal);
        if (signal.aborted) return controlFail(CONTROL_CODES.CANCELLED);
        admitted.check();
        if (!routeAllowed()) return controlFail(CONTROL_CODES.POLICY);
        const published = admitted.publish(response);
        await writeControlFrame(
          stream,
          published,
          CONTROL_LIMITS.responseBytes,
        );
        if (!routeAllowed()) return controlFail(CONTROL_CODES.POLICY);
      },
      service.queryMs,
      closeOnce,
      external,
    );
  } catch {
    closeOnce();
  } finally {
    lease?.cancel();
    release();
  }
}
export async function handleControlConnection(
  connection: Connection,
  service: ControlService,
  signal: AbortSignal,
  enter: () => (() => void) | undefined,
  isClosed: () => boolean,
  routeAllowed: () => boolean,
) {
  const peer = connection.remoteId().toString();
  const session = service.open(peer);
  const close = () => connection.close(HTTP_OVER_IROH.streamCloseCode, []);
  try {
    await handleIrohConnection(
      connection,
      (stream) =>
        serveControlStream(
          stream,
          service,
          session,
          peer,
          close,
          signal,
          enter,
          routeAllowed,
        ),
      isClosed,
      {
        idleMs: service.idleMs,
        receiveBytes: CONTROL_LIMITS.requestBytes + CONTROL_LIMITS.prefixBytes,
      },
    );
  } finally {
    session.close();
  }
}
