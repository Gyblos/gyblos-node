// Public synthetic vector values exercise session event framing without SDKs, engines or private state.
import { readFile } from 'node:fs/promises';

import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  batchChannelDigest,
  batchChannelResponse,
  batchSessionRequest,
  parseBatchChannelRequest,
  type BatchExecutionRequest,
} from '@gyblos/protocol/batch-channel';
import {
  BATCH_STREAM,
  encodeBatchStreamEvent,
} from '@gyblos/protocol/batch-stream';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { BatchEndpoint } from '@gyblos/transport-iroh/batch-client';

import { batchDeferred } from './batch-deferred';

export async function batchStreamFixture() {
  const raw: { execution: BatchExecutionRequest } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/batch-channel-v3.json'),
      ),
      'utf8',
    ),
  );
  const request = parseBatchChannelRequest({
    version: BATCH_CHANNEL.version,
    requestId: 'ab'.repeat(16),
    method: BATCH_METHODS.EXECUTE,
    params: raw.execution,
  });
  if (request.method !== BATCH_METHODS.EXECUTE)
    throw new Error('Synthetic method mismatch');
  const pending = await batchSessionRequest(raw.execution);
  const value = {
    text: 'ok!',
    usage: { inputTokens: 12, outputTokens: 3 },
    finishReason: ENGINE_DONE_REASONS.STOP,
  };
  const bill = { ...pending, chargedAtomic: '15', cumulativeAtomic: '15' };
  const response = await batchChannelResponse(request, { value, bill });
  const header = {
    version: BATCH_CHANNEL.version,
    requestId: request.requestId,
    requestDigest: await batchChannelDigest(request),
  };
  const delta = {
    ...header,
    sequence: 0,
    type: BATCH_STREAM.events.DELTA,
    text: 'ok!',
  };
  const terminal = {
    ...header,
    sequence: 1,
    type: BATCH_STREAM.events.TERMINAL,
    response,
  };
  return { request, value, bill, response, header, delta, terminal };
}
export function batchMemoryPeer(bytes: Uint8Array, writeFailure = false) {
  let offset = 0;
  let reads = 0;
  let writes = 0;
  const closed = batchDeferred<void>();
  const destination = {
    id: () => ({ toString: () => '34'.repeat(32) }),
    relayUrl: () => null,
  };
  const endpoint: BatchEndpoint<typeof destination> = {
    id: () => ({ toString: () => '12'.repeat(32) }),
    connect: async () => ({
      remoteId: destination.id,
      paths: () => [],
      closed: () => closed.promise,
      close: () => closed.resolve(),
      openBi: async () => ({
        send: {
          async writeAll() {
            writes++;
            if (writeFailure) throw new Error('Synthetic uncertain write');
          },
          async finish() {},
        },
        recv: {
          async readExact(length) {
            reads++;
            if (offset + length > bytes.length)
              throw new Error('Synthetic incomplete frame');
            const out = bytes.slice(offset, offset + length);
            offset += length;
            return [...out];
          },
          async read(length) {
            reads++;
            const out = bytes.slice(offset, offset + length);
            offset += out.length;
            return [...out];
          },
        },
      }),
    }),
  };
  return { endpoint, destination, reads: () => reads, writes: () => writes };
}
export function batchStreamBytes(...events: unknown[]) {
  return Buffer.concat(
    events.map((event) => Buffer.from(encodeBatchStreamEvent(event))),
  );
}
