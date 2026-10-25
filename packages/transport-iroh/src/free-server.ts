// Serves the isolated free data channel under endpoint admission and existing inference deadlines.
// The caller owns inference policy; transport never imports engines, payments or node code.
import type { Connection } from '@number0/iroh';

import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import {
  CONTROL_LIMITS,
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import {
  FreeExecutionError,
  type FreeExecutionResponse,
} from '@gyblos/protocol/free-execution';
import {
  encodeFreeExecutionResponse,
  FreeExecutionRequestReader,
} from '@gyblos/protocol/free-execution-framing';

import { HTTP_OVER_IROH, IROH_DEADLINES } from './constants.js';
import type { ControlStream } from './control-io.js';
import { handleIrohConnection } from './iroh-connection.js';

export interface FreeExecutionService {
  respond(
    value: unknown,
    peer: string,
    signal: AbortSignal,
  ): Promise<FreeExecutionResponse>;
}
interface FreeStreamDeadlines {
  ingressMs?: number;
  requestMs?: number;
  egressMs?: number;
}
function fail(
  code: ConstructorParameters<typeof FreeExecutionError>[0],
): never {
  throw new FreeExecutionError(code);
}
function check(signal: AbortSignal, allowed: () => boolean) {
  if (signal.aborted) return fail(FREE_EXECUTION_CODES.CANCELLED);
  if (!allowed()) return fail(FREE_EXECUTION_CODES.PEER);
}
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
          reject(new FreeExecutionError(FREE_EXECUTION_CODES.TIMEOUT));
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function receiving(signal: AbortSignal) {
  if (signal.aborted) return fail(FREE_EXECUTION_CODES.CANCELLED);
}
async function readRequest(stream: ControlStream, signal: AbortSignal) {
  receiving(signal);
  const reader = new FreeExecutionRequestReader();
  const prefix = Uint8Array.from(
    await stream.recv.readExact(CONTROL_LIMITS.prefixBytes),
  );
  receiving(signal);
  reader.push(prefix);
  const length = new DataView(prefix.buffer).getUint32(0);
  reader.push(Uint8Array.from(await stream.recv.readExact(length)));
  receiving(signal);
  if ((await stream.recv.read(1)).length)
    return fail(FREE_EXECUTION_CODES.INVALID);
  receiving(signal);
  return reader.finish();
}
async function readBoundedRequest(
  stream: ControlStream,
  signal: AbortSignal,
  milliseconds: number,
  cancel: () => void,
) {
  const reading = readRequest(stream, signal);
  try {
    return await deadline(reading, milliseconds, cancel);
  } finally {
    await reading.catch(() => undefined);
  }
}
export async function serveFreeExecutionStream(
  stream: ControlStream,
  service: FreeExecutionService,
  peer: string,
  close: () => void,
  external: AbortSignal,
  enter: () => (() => void) | undefined,
  routeAllowed: () => boolean = () => true,
  limits: FreeStreamDeadlines = {},
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
  const operation = Promise.resolve().then(async () => {
    check(controller.signal, routeAllowed);
    const request = await readBoundedRequest(
      stream,
      controller.signal,
      limits.ingressMs ?? IROH_DEADLINES.ingressMs,
      cancel,
    );
    check(controller.signal, routeAllowed);
    const response = await service.respond(request, peer, controller.signal);
    check(controller.signal, routeAllowed);
    const bytes = encodeFreeExecutionResponse(response);
    const sending = (async () => {
      await stream.send.writeAll([...bytes]);
      check(controller.signal, routeAllowed);
      await stream.send.finish();
    })();
    // The enclosing operation must not settle while a native writer is still pending.
    try {
      await deadline(
        sending,
        limits.egressMs ?? IROH_DEADLINES.egressMs,
        cancel,
      );
    } finally {
      await sending.catch(() => undefined);
    }
    check(controller.signal, routeAllowed);
  });
  try {
    await deadline(
      operation,
      limits.requestMs ?? TRANSPORT_TIMEOUTS.requestMs,
      cancel,
    );
  } catch {
    cancel();
  } finally {
    // An engine ignoring abort retains the shared request permit until its actual work settles.
    await operation.catch(() => undefined);
    external.removeEventListener('abort', cancel);
    release();
  }
}
export async function handleFreeExecutionConnection(
  connection: Connection,
  service: FreeExecutionService,
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
      serveFreeExecutionStream(
        stream,
        service,
        peer,
        close,
        signal,
        enter,
        routeAllowed,
      ),
    isClosed,
    { receiveBytes: FREE_EXECUTION.requestBytes + CONTROL_LIMITS.prefixBytes },
  );
}
