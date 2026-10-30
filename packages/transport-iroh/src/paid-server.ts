// Serves the paid stream channel under endpoint admission and the inference deadlines. The
// caller's service owns quote checks, payment, metering and settlement; transport never imports
// engines, payments or node code. A cancelled or timed-out stream aborts the service's signal and
// closes the connection, but keeps the admission lease until the service settled.
import type { Connection } from '@number0/iroh';

import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import {
  paidExecutionFail as fail,
  PaidExecutionError,
} from '@gyblos/protocol/paid-execution';
import { decodePaidExecutionRequest } from '@gyblos/protocol/paid-stream';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
} from '@gyblos/protocol/paid/constants';

import { HTTP_OVER_IROH, IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';
import { handleIrohConnection } from './iroh-connection';
import {
  streamPaidResponse,
  type PaidExecutionService,
} from './paid-stream-server';

export type { PaidExecutionService } from './paid-stream-server';

export interface PaidStreamDeadlines {
  ingressMs?: number;
  requestMs?: number;
  egressMs?: number;
}

function guard(signal: AbortSignal, allowed: () => boolean) {
  if (signal.aborted) return fail(PAID_EXECUTION_CODES.CANCELLED);
  if (!allowed()) return fail(PAID_EXECUTION_CODES.PEER);
}

// The enclosing operation must not settle while a native reader or writer is still pending.
async function deadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  cancel: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          cancel();
          reject(new PaidExecutionError(PAID_EXECUTION_CODES.TIMEOUT));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await operation.catch(() => undefined);
  }
}

async function readRequest(stream: ControlStream, check: () => void) {
  check();
  const prefix = Uint8Array.from(
    await stream.recv.readExact(CONTROL_LIMITS.prefixBytes),
  );
  check();
  // An oversized length is refused before any body is allocated or read.
  const length = new DataView(prefix.buffer).getUint32(0);
  if (!length) return fail();
  if (length > PAID_EXECUTION.requestBytes)
    return fail(PAID_EXECUTION_CODES.LIMIT);
  const frame = new Uint8Array(prefix.length + length);
  frame.set(prefix);
  frame.set(await stream.recv.readExact(length), prefix.length);
  check();
  if ((await stream.recv.read(1)).length) return fail();
  check();
  return decodePaidExecutionRequest(frame);
}

async function respond(
  stream: ControlStream,
  service: PaidExecutionService,
  peer: string,
  signal: AbortSignal,
  check: () => void,
  limits: PaidStreamDeadlines,
  cancel: () => void,
) {
  const egressMs = limits.egressMs ?? IROH_DEADLINES.egressMs;
  const request = await deadline(
    readRequest(stream, check),
    limits.ingressMs ?? IROH_DEADLINES.ingressMs,
    cancel,
  );
  await streamPaidResponse(request, service, peer, signal, check, (frame) =>
    deadline(stream.send.writeAll([...frame]), egressMs, cancel),
  );
  check();
  await deadline(stream.send.finish(), egressMs, cancel);
  check();
}

export async function servePaidExecutionStream(
  stream: ControlStream,
  service: PaidExecutionService,
  peer: string,
  close: () => void,
  external: AbortSignal,
  enter: () => (() => void) | undefined,
  routeAllowed: () => boolean = () => true,
  limits: PaidStreamDeadlines = {},
) {
  const release = enter();
  if (!release) {
    close();
    return;
  }
  const controller = new AbortController();
  let closed = false;
  const cancel = () => {
    controller.abort();
    if (!closed) {
      closed = true;
      close();
    }
  };
  external.addEventListener('abort', cancel, { once: true });
  if (external.aborted) cancel();
  const check = () => guard(controller.signal, routeAllowed);
  const operation = Promise.resolve().then(() =>
    respond(stream, service, peer, controller.signal, check, limits, cancel),
  );
  try {
    await deadline(
      operation,
      limits.requestMs ?? TRANSPORT_TIMEOUTS.requestMs,
      cancel,
    );
  } catch {
    cancel();
  } finally {
    // A service still settling keeps the shared request permit until it returns.
    await operation.catch(() => undefined);
    external.removeEventListener('abort', cancel);
    release();
  }
}

export async function handlePaidExecutionConnection(
  connection: Connection,
  service: PaidExecutionService,
  signal: AbortSignal,
  enter: () => (() => void) | undefined,
  isClosed: () => boolean,
  routeAllowed: () => boolean,
) {
  const peer = connection.remoteId().toString();
  const close = () => connection.close(HTTP_OVER_IROH.streamCloseCode, []);
  await handleIrohConnection(
    connection,
    (stream) =>
      servePaidExecutionStream(
        stream,
        service,
        peer,
        close,
        signal,
        enter,
        routeAllowed,
      ),
    isClosed,
    {
      receiveBytes: PAID_EXECUTION.requestBytes + CONTROL_LIMITS.prefixBytes,
    },
  );
}
