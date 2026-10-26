// Verifies the streaming transport holds shared admission through cancellation and awaited writes.
// Frames and policy are synthetic; no engine, sockets or payment service is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import { parseFreeExecutionResponse } from '@gyblos/protocol/free-execution';
import { decodeFreeStreamEvent } from '@gyblos/protocol/free-stream';
import type { ControlStream } from '@gyblos/transport-iroh/control-io';
import {
  serveFreeExecutionStream,
  type FreeExecutionService,
} from '@gyblos/transport-iroh/free-server';

async function fixture() {
  const vector: { requestFrameHex: string; response: unknown } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/free-execution-v2.json'),
      ),
      'utf8',
    ),
  );
  const frame = Buffer.from(vector.requestFrameHex, 'hex');
  let offset = 0;
  let released = 0;
  let closed = 0;
  let reads = 0;
  const frames: unknown[] = [];
  const stream: ControlStream = {
    recv: {
      async readExact(size) {
        reads++;
        const value = frame.subarray(offset, offset + size);
        offset += size;
        return [...value];
      },
      async read() {
        return [];
      },
    },
    send: {
      async writeAll(bytes) {
        frames.push(decodeFreeStreamEvent(Uint8Array.from(bytes)));
      },
      async finish() {},
    },
  };
  const service: FreeExecutionService = {
    async respond() {
      throw new Error('complete channel must not execute');
    },
    async stream(_request, _peer, _signal, onDelta) {
      await onDelta('Hello');
      await onDelta('.');
      return parseFreeExecutionResponse(vector.response);
    },
  };
  const close = () => {
    closed++;
  };
  const enter = () => () => {
    released++;
  };
  return {
    stream,
    service,
    close,
    enter,
    frames,
    counts: () => ({ released, closed, reads }),
  };
}
void test('streaming server emits ordered events under the shared request lease', async () => {
  const value = await fixture();
  await serveFreeExecutionStream(
    value.stream,
    value.service,
    'synthetic',
    value.close,
    new AbortController().signal,
    value.enter,
    () => true,
    {},
    true,
  );
  assert.equal(value.frames.length, 3);
  assert.deepEqual(
    value.frames.map((frame) =>
      frame && typeof frame === 'object' && 'sequence' in frame
        ? frame.sequence
        : undefined,
    ),
    [0, 1, 2],
  );
  assert.equal(value.counts().released, 1);
  const denied = await fixture();
  await serveFreeExecutionStream(
    denied.stream,
    denied.service,
    'synthetic',
    denied.close,
    new AbortController().signal,
    () => undefined,
    () => true,
    {},
    true,
  );
  assert.equal(denied.counts().reads, 0);
  assert.equal(denied.counts().closed, 1);
});
void test('streaming cancellation reaches policy, suppresses late writes and retains its lease until settled', async () => {
  const value = await fixture();
  const controller = new AbortController();
  let unblock = () => {};
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let policySignal: AbortSignal | undefined;
  let late: ((text: string) => Promise<void>) | undefined;
  const service: FreeExecutionService = {
    ...value.service,
    async stream(request, peer, signal, onDelta) {
      policySignal = signal;
      late = onDelta;
      await onDelta('Hello');
      started();
      await pending;
      await assert.rejects(onDelta('.'), {
        code: FREE_EXECUTION_CODES.CANCELLED,
      });
      return value.service.stream!(request, peer, signal, async () => {});
    },
  };
  const running = serveFreeExecutionStream(
    value.stream,
    service,
    'synthetic',
    value.close,
    controller.signal,
    value.enter,
    () => true,
    {},
    true,
  );
  await entered;
  controller.abort();
  assert.equal(policySignal?.aborted, true);
  assert.equal(value.counts().released, 0);
  unblock();
  await running;
  assert.equal(value.frames.length, 1);
  assert.equal(value.counts().released, 1);
  await assert.rejects(late!('late'), { code: FREE_EXECUTION_CODES.CANCELLED });
});
void test('streaming egress deadline retains an uncooperative writer until actual settlement', async () => {
  const value = await fixture();
  let settle = () => {};
  let stopped = () => {};
  const closed = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  value.stream.send.writeAll = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  const running = serveFreeExecutionStream(
    value.stream,
    value.service,
    'synthetic',
    () => {
      value.close();
      stopped();
    },
    new AbortController().signal,
    value.enter,
    () => true,
    { egressMs: 10 },
    true,
  );
  await closed;
  assert.equal(value.counts().released, 0);
  settle();
  await running;
  assert.equal(value.counts().released, 1);
});
void test('streaming aggregate wire limit reserves room for a typed terminal error', async () => {
  const value = await fixture();
  const original = await value.service.stream!(
    {},
    'synthetic',
    new AbortController().signal,
    async () => {},
  );
  let limitReached = false;
  const service: FreeExecutionService = {
    ...value.service,
    async stream(_request, _peer, _signal, onDelta) {
      try {
        for (let index = 0; index < 4096; index++)
          await onDelta('\u0000'.repeat(64));
        throw new Error('limit not enforced');
      } catch (error) {
        assert.equal(
          error instanceof Error && 'code' in error ? error.code : undefined,
          FREE_EXECUTION_CODES.LIMIT,
        );
        limitReached = true;
        return {
          version: original.version,
          requestId: original.requestId,
          requestDigest: original.requestDigest,
          error: { code: FREE_EXECUTION_CODES.LIMIT },
        };
      }
    },
  };
  await serveFreeExecutionStream(
    value.stream,
    service,
    'synthetic',
    value.close,
    new AbortController().signal,
    value.enter,
    () => true,
    {},
    true,
  );
  assert.equal(limitReached, true);
  const last = value.frames.at(-1);
  assert.ok(last && typeof last === 'object' && 'response' in last);
  assert.equal(
    parseFreeExecutionResponse(last.response).error?.code,
    FREE_EXECUTION_CODES.LIMIT,
  );
  assert.equal(value.counts().closed, 0);
});
