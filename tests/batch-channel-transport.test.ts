// Deterministic bounded session stream tests; all requests and financial identifiers are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';
import { SESSION_STATES } from '@gyblos/protocol/payment-session';
import { serveBatchChannelStream } from '@gyblos/transport-iroh/batch-server';
import type { ControlStream } from '@gyblos/transport-iroh/control-io';

const request: BatchChannelRequest = {
  version: BATCH_CHANNEL.version,
  requestId: '12'.repeat(16),
  method: BATCH_METHODS.SNAPSHOT,
  params: { channelId: '11111111111111111111111111111111' },
};
function memory(frame: Uint8Array, extra = false) {
  let at = 0;
  const reads: number[] = [];
  const written: number[] = [];
  const stream: ControlStream = {
    recv: {
      async readExact(length) {
        reads.push(length);
        const data = frame.slice(at, at + length);
        at += length;
        return [...data];
      },
      async read() {
        return extra ? [1] : [];
      },
    },
    send: {
      async writeAll(bytes) {
        written.push(...bytes);
      },
      async finish() {},
    },
  };
  return { stream, reads, written };
}
void test('batch stream serves one complete canonical request and releases admission', async () => {
  const wire = memory(encodeControlFrame(request, BATCH_CHANNEL.requestBytes));
  let calls = 0;
  let released = 0;
  const snapshot = {
    channelId: request.params.channelId,
    state: SESSION_STATES.OPEN,
    expiresAt: 1800000000000,
    cumulativeAtomic: '0',
    reservedAtomic: '0',
  };
  await serveBatchChannelStream(
    wire.stream,
    {
      async exchange(_request, peer) {
        calls++;
        assert.equal(peer, '34'.repeat(32));
        return { snapshot };
      },
    },
    '34'.repeat(32),
    () => assert.fail('valid stream must not close'),
    new AbortController().signal,
    () => () => {
      released++;
    },
  );
  assert.equal(calls, 1);
  assert.equal(released, 1);
  const reader = new ControlFrameReader(BATCH_CHANNEL.responseBytes);
  reader.push(Uint8Array.from(wire.written));
  assert.ok(reader.finish());
});
void test('batch stream rejects oversized prefix without reading a body or entering policy', async () => {
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, BATCH_CHANNEL.requestBytes + 1);
  const wire = memory(prefix);
  let closed = 0;
  let released = 0;
  await serveBatchChannelStream(
    wire.stream,
    {
      async exchange() {
        assert.fail('must not call policy');
      },
    },
    '34'.repeat(32),
    () => {
      closed++;
    },
    new AbortController().signal,
    () => () => {
      released++;
    },
  );
  assert.deepEqual(wire.reads, [4]);
  assert.equal(wire.written.length, 0);
  assert.equal(closed, 1);
  assert.equal(released, 1);
});
