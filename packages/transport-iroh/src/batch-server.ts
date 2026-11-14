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

import { respondBlockApproval } from './batch-block-resume';
import { streamBatchBlocks } from './batch-block-server';
import type { BatchBlockExchange } from './batch-block-types';
import { batchDeadline, readBatchMessage } from './batch-io';
import { streamBatchResponse } from './batch-stream-server';
import { HTTP_OVER_IROH, IROH_DEADLINES } from './constants';
import type { ControlStream } from './control-io';
import { handleIrohConnection } from './iroh-connection';

export type { BatchBlockExchange } from './batch-block-types';
export type { BatchBlockClient } from './batch-block-types';

export interface BatchChannelService {
  resumeBlock?(
    approval: import('@gyblos/protocol/session-blocks').SessionBlockApproval,
    peer: string,
    signal: AbortSignal,
  ): Promise<import('@gyblos/protocol/session-blocks').SessionBlockAck>;
  exchange(
    request: BatchChannelRequest,
    peer: string,
    signal: AbortSignal,
    onDelta?: (text: string) => Promise<void>,
    blocks?: BatchBlockExchange,
    blockMode?: boolean,
  ): Promise<BatchChannelResult>;
}
export interface BatchStreamLimits {
  blocks?: boolean;
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
async function respondExecution(
  request: Extract<
    BatchChannelRequest,
    { method: typeof BATCH_METHODS.EXECUTE }
  >,
  stream: ControlStream,
  service: BatchChannelService,
  peer: string,
  signal: AbortSignal,
  check: () => void,
  cancel: () => void,
  limits: BatchStreamLimits,
  admitExecution: () => boolean,
) {
  const admitted: BatchChannelService = {
    async exchange(...args) {
      check();
      if (!admitExecution()) throw new BatchChannelError(SESSION_CODES.LIMIT);
      return service.exchange(...args);
    },
  };
  const stage: import('./batch-block-io').BlockStage = (
    operation,
    milliseconds,
  ) => batchDeadline(operation, milliseconds, cancel);
  if (limits.blocks)
    return streamBatchBlocks(
      request,
      stream,
      admitted,
      peer,
      signal,
      check,
      stage,
    );
  await streamBatchResponse(
    request,
    admitted,
    peer,
    signal,
    check,
    (bytes) =>
      stage(
        stream.send.writeAll([...bytes]),
        limits.egressMs ?? IROH_DEADLINES.egressMs,
      ),
    cancel,
  );
  check();
  await stage(stream.send.finish(), limits.egressMs ?? IROH_DEADLINES.egressMs);
  check();
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
  const raw = await readRequest(stream, check, cancel, limits);
  check();
  if (
    limits.blocks &&
    raw !== null &&
    typeof raw === 'object' &&
    'kind' in raw
  ) {
    return respondBlockApproval(
      raw,
      stream,
      service,
      peer,
      signal,
      check,
      (operation, milliseconds) =>
        batchDeadline(operation, milliseconds, cancel),
    );
  }
  const request = parseBatchChannelRequest(raw);
  if (request.method === BATCH_METHODS.EXECUTE)
    return respondExecution(
      request,
      stream,
      service,
      peer,
      signal,
      check,
      cancel,
      limits,
      admitExecution,
    );
  let response: BatchChannelResponse;
  try {
    response = await batchChannelResponse(
      request,
      await service.exchange(
        request,
        peer,
        signal,
        undefined,
        undefined,
        limits.blocks,
      ),
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
async function readRequest(
  stream: ControlStream,
  check: () => void,
  cancel: () => void,
  limits: BatchStreamLimits,
) {
  const started = performance.now();
  const maximumMs = limits.ingressMs ?? IROH_DEADLINES.ingressMs;
  const raw = await batchDeadline(
    readBatchMessage(stream, BATCH_CHANNEL.requestBytes, check),
    maximumMs,
    cancel,
  );
  check();
  const duplex =
    limits.blocks &&
    raw !== null &&
    typeof raw === 'object' &&
    'method' in raw &&
    raw.method === BATCH_METHODS.EXECUTE;
  if (!duplex) {
    const remaining = maximumMs - (performance.now() - started);
    if (
      remaining <= 0 ||
      (await batchDeadline(stream.recv.read(1), remaining, cancel)).length
    )
      throw new BatchChannelError(SESSION_CODES.INVALID);
    check();
  }
  return raw;
}
export async function serveBatchChannelStream(
  stream: ControlStream,
  service: BatchChannelService,
  peer: string,
  close: () => void,
  external: AbortSignal,
  enter: (
    signal: AbortSignal,
  ) => (() => void) | undefined | Promise<(() => void) | undefined>,
  allowed: () => boolean = () => true,
  limits: BatchStreamLimits = {},
  admitExecution: () => boolean = () => true,
): Promise<void> {
  const controller = new AbortController();
  let release: (() => void) | undefined;
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
  const operation = Promise.resolve().then(async () => {
    check();
    const ingressStarted = performance.now();
    const ingressLimit = limits.ingressMs ?? IROH_DEADLINES.ingressMs;
    // A peer may have received the previous FIN before its server continuation released admission.
    // Handoff and frame parsing share the original ingress budget; waiting never renews a deadline.
    release = await batchDeadline(
      Promise.resolve(enter(controller.signal)),
      ingressLimit,
      cancel,
    );
    check();
    if (!release) {
      cancel();
      return;
    }
    const ingressMs = ingressLimit - (performance.now() - ingressStarted);
    if (ingressMs <= 0) {
      cancel();
      return;
    }
    return respond(
      stream,
      service,
      peer,
      controller.signal,
      check,
      cancel,
      { ...limits, ingressMs },
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
    release?.();
  }
}
export function handleBatchChannelConnection(
  connection: Connection,
  service: BatchChannelService,
  signal: AbortSignal,
  enter: (
    signal: AbortSignal,
  ) => (() => void) | undefined | Promise<(() => void) | undefined>,
  isClosed: () => boolean,
  allowed: () => boolean,
  admitExecution: () => boolean,
  blocks = false,
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
        { blocks },
        admitExecution,
      ),
    isClosed,
    { receiveBytes: BATCH_CHANNEL.requestBytes + CONTROL_LIMITS.prefixBytes },
  );
}
