// Bounded session RPC over one bidirectional stream; generation and payment remain in the service.
import type { Connection } from '@number0/iroh';

import { TRANSPORT_TIMEOUTS } from '@gyblos/config';
import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  batchChannelDigest,
  BatchChannelError,
  batchChannelResponse,
  batchError,
  parseBatchChannelRequest,
  type BatchChannelRequest,
  type BatchChannelResponse,
  type BatchChannelResult,
} from '@gyblos/protocol/batch-channel';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchDeadline, readBatchFrame } from './batch-io';
import { streamBatchResponse } from './batch-stream-server';
import { HTTP_OVER_IROH, IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';
import { handleIrohConnection } from './iroh-connection';

export interface BatchChannelService {
  exchange(
    request: BatchChannelRequest,
    peer: string,
    signal: AbortSignal,
    onDelta?: (text: string) => Promise<void>,
  ): Promise<BatchChannelResult>;
}
export interface BatchStreamLimits {
  ingressMs?: number;
  requestMs?: number;
  egressMs?: number;
}
async function errorReply(
  request: BatchChannelRequest,
  error: unknown,
): Promise<BatchChannelResponse> {
  return {
    version: BATCH_CHANNEL.version,
    requestId: request.requestId,
    requestDigest: await batchChannelDigest(request),
    error: { code: batchError(error).code },
  };
}
async function respond(
  stream: ControlStream,
  service: BatchChannelService,
  peer: string,
  signal: AbortSignal,
  check: () => void,
  cancel: () => void,
  limits: BatchStreamLimits,
  admitExecution: () => boolean,
) {
  const raw = await batchDeadline(
    readBatchFrame(stream, BATCH_CHANNEL.requestBytes, check),
    limits.ingressMs ?? IROH_DEADLINES.ingressMs,
    cancel,
  );
  check();
  const request = parseBatchChannelRequest(raw);
  if (request.method === BATCH_METHODS.EXECUTE) {
    await streamBatchResponse(
      request,
      {
        async exchange(...args) {
          check();
          if (!admitExecution())
            throw new BatchChannelError(SESSION_CODES.LIMIT);
          return service.exchange(...args);
        },
      },
      peer,
      signal,
      check,
      (bytes) =>
        batchDeadline(
          stream.send.writeAll([...bytes]),
          limits.egressMs ?? IROH_DEADLINES.egressMs,
          cancel,
        ),
      cancel,
    );
    check();
    await batchDeadline(
      stream.send.finish(),
      limits.egressMs ?? IROH_DEADLINES.egressMs,
      cancel,
    );
    check();
    return;
  }
  let response: BatchChannelResponse;
  try {
    response = await batchChannelResponse(
      request,
      await service.exchange(request, peer, signal),
    );
  } catch (error) {
    response = await errorReply(request, error);
  }
  check();
  let bytes: Uint8Array;
  try {
    bytes = encodeControlFrame(response, BATCH_CHANNEL.responseBytes);
  } catch {
    bytes = encodeControlFrame(
      await errorReply(request, new BatchChannelError(SESSION_CODES.LIMIT)),
      BATCH_CHANNEL.responseBytes,
    );
  }
  await batchDeadline(
    (async () => {
      check();
      await stream.send.writeAll([...bytes]);
      check();
      await stream.send.finish();
      check();
    })(),
    limits.egressMs ?? IROH_DEADLINES.egressMs,
    cancel,
  );
}
export async function serveBatchChannelStream(
  stream: ControlStream,
  service: BatchChannelService,
  peer: string,
  close: () => void,
  external: AbortSignal,
  enter: () => (() => void) | undefined,
  allowed: () => boolean = () => true,
  limits: BatchStreamLimits = {},
  admitExecution: () => boolean = () => true,
): Promise<void> {
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
  const check = () => {
    if (controller.signal.aborted || !allowed())
      throw new BatchChannelError(PAID_EXECUTION_CODES.CANCELLED);
  };
  const operation = Promise.resolve().then(() => {
    check();
    return respond(
      stream,
      service,
      peer,
      controller.signal,
      check,
      cancel,
      limits,
      admitExecution,
    );
  });
  try {
    await batchDeadline(
      operation,
      limits.requestMs ?? TRANSPORT_TIMEOUTS.requestMs,
      cancel,
    );
  } catch {
    cancel();
  } finally {
    await operation.catch(() => undefined);
    external.removeEventListener('abort', cancel);
    release();
  }
}
export function handleBatchChannelConnection(
  connection: Connection,
  service: BatchChannelService,
  signal: AbortSignal,
  enter: () => (() => void) | undefined,
  isClosed: () => boolean,
  allowed: () => boolean,
  admitExecution: () => boolean,
) {
  const controller = new AbortController();
  const current = AbortSignal.any([signal, controller.signal]);
  void connection.closed().then(
    () => controller.abort(),
    () => controller.abort(),
  );
  return handleIrohConnection(
    connection,
    (stream) =>
      serveBatchChannelStream(
        stream,
        service,
        connection.remoteId().toString(),
        () => connection.close(HTTP_OVER_IROH.streamCloseCode, []),
        current,
        enter,
        allowed,
        {},
        admitExecution,
      ),
    isClosed,
    { receiveBytes: BATCH_CHANNEL.requestBytes + CONTROL_LIMITS.prefixBytes },
  );
}
