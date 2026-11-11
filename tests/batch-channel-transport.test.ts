// Deterministic bounded session stream tests; all requests and financial identifiers are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  batchSessionRequest,
  buildBatchExecutionRequest,
  matchBatchChannelResponse,
  type BatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import {
  BATCH_STREAM,
  decodeBatchStreamEvent,
} from '@gyblos/protocol/batch-stream';
import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
} from '@gyblos/protocol/constants';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';
import { serveBatchChannelStream } from '@gyblos/transport-iroh/batch-server';
import type { ControlStream } from '@gyblos/transport-iroh/control-io';

import { batchDeferred } from './support/batch-deferred';
import { paidSource } from './support/paid-fixture';

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

void test('batch ingress timeout drains the original native read before releasing admission', async () => {
  const prefix = batchDeferred<number[]>();
  const closed = batchDeferred<void>();
  const reads: number[] = [];
  let released = 0;
  const stream: ControlStream = {
    recv: {
      async readExact(length) {
        reads.push(length);
        return prefix.promise;
      },
      async read() {
        return [];
      },
    },
    send: {
      async writeAll() {
        assert.fail('must not write after timeout');
      },
      async finish() {},
    },
  };
  const running = serveBatchChannelStream(
    stream,
    {
      async exchange() {
        assert.fail('must not call policy');
      },
    },
    '34'.repeat(32),
    () => closed.resolve(),
    new AbortController().signal,
    () => () => {
      released++;
    },
    () => true,
    { ingressMs: 1, requestMs: 1000 },
  );
  try {
    await closed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(released, 0);
  } finally {
    prefix.resolve([0, 0, 0, 1]);
    await running;
  }
  assert.deepEqual(reads, [4]);
  assert.equal(released, 1);
});

void test('batch egress timeout retains admission until the original native write settles', async () => {
  const sending = batchDeferred<void>();
  const closed = batchDeferred<void>();
  const wire = memory(encodeControlFrame(request, BATCH_CHANNEL.requestBytes));
  wire.stream.send.writeAll = async () => sending.promise;
  let released = 0;
  const running = serveBatchChannelStream(
    wire.stream,
    {
      async exchange() {
        return {
          snapshot: {
            channelId: request.params.channelId,
            expiresAt: 1800000000000,
            state: SESSION_STATES.OPEN,
            cumulativeAtomic: '0',
            reservedAtomic: '0',
          },
        };
      },
    },
    '34'.repeat(32),
    () => closed.resolve(),
    new AbortController().signal,
    () => () => {
      released++;
    },
    () => true,
    { egressMs: 1, requestMs: 1000 },
  );
  try {
    await closed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(released, 0);
  } finally {
    sending.resolve();
    await running;
  }
  assert.equal(released, 1);
});
void test('batch endpoint admission refuses without reading or calling service', async () => {
  const wire = memory(encodeControlFrame(request, BATCH_CHANNEL.requestBytes));
  let closed = 0;
  await serveBatchChannelStream(
    wire.stream,
    {
      async exchange() {
        assert.fail('must not call service');
      },
    },
    '34'.repeat(32),
    () => {
      closed++;
    },
    new AbortController().signal,
    () => undefined,
  );
  assert.equal(closed, 1);
  assert.deepEqual(wire.reads, []);
  assert.equal(wire.written.length, 0);
});
void test('batch framing rejects ambiguous JSON, trailing bytes and incomplete bodies before service', async () => {
  const canonical = encodeControlFrame(request, BATCH_CHANNEL.requestBytes);
  const duplicate = Buffer.from(
    '{"version":1,"version":1,"requestId":"' +
      request.requestId +
      '","method":"snapshot","params":{"channelId":"' +
      request.params.channelId +
      '"}}',
  );
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(duplicate.length);
  for (const wire of [
    memory(Buffer.concat([prefix, duplicate])),
    memory(canonical, true),
    memory(canonical.slice(0, -1)),
  ]) {
    let closed = 0;
    await serveBatchChannelStream(
      wire.stream,
      {
        async exchange() {
          assert.fail('ambiguous frame must not execute');
        },
      },
      '34'.repeat(32),
      () => {
        closed++;
      },
      new AbortController().signal,
      () => () => {},
    );
    assert.equal(closed, 1);
    assert.equal(wire.written.length, 0);
  }
});

void test('a legal response whose JSON escapes exceed the frame produces a static LIMIT frame', async () => {
  const source = await paidSource();
  const execution = buildBatchExecutionRequest(
    request.params.channelId,
    source.paid.quote,
    source.paid.input,
  );
  const call: BatchChannelRequest = {
    version: BATCH_CHANNEL.version,
    requestId: '56'.repeat(16),
    method: BATCH_METHODS.EXECUTE,
    params: execution,
  };
  const pending = await batchSessionRequest(execution);
  const wire = memory(encodeControlFrame(call, BATCH_CHANNEL.requestBytes));
  await serveBatchChannelStream(
    wire.stream,
    {
      async exchange() {
        return {
          value: {
            text: '\u0001'.repeat(FREE_EXECUTION.outputBytes),
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: ENGINE_DONE_REASONS.STOP,
          },
          bill: { ...pending, chargedAtomic: '1', cumulativeAtomic: '1' },
        };
      },
    },
    '34'.repeat(32),
    () => assert.fail('must send a LIMIT response'),
    new AbortController().signal,
    () => () => {},
  );
  const event = decodeBatchStreamEvent(Uint8Array.from(wire.written));
  assert.equal(event.type, BATCH_STREAM.events.TERMINAL);
  if (event.type !== BATCH_STREAM.events.TERMINAL)
    assert.fail('Expected static terminal');
  await assert.rejects(matchBatchChannelResponse(event.response, call), {
    code: SESSION_CODES.LIMIT,
    remote: true,
  });
});
