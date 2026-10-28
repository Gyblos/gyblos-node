// Tests bounded data-channel I/O with synthetic streams, including ignored cancellation; no network or engine.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FREE_EXECUTION } from '@gyblos/protocol/constants';
import { parseFreeExecutionResponse } from '@gyblos/protocol/free-execution';
import type { ControlStream } from '@gyblos/transport-iroh/control-io';
import {
  serveFreeExecutionStream,
  type FreeExecutionService,
} from '@gyblos/transport-iroh/free-server';

async function fixture() {
  const vector: { requestFrameHex: string; response: unknown } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/free-execution-v3.json'),
      ),
      'utf8',
    ),
  );
  const frame = Buffer.from(vector.requestFrameHex, 'hex');
  let offset = 0;
  let writes = 0;
  let releases = 0;
  let closes = 0;
  const reads: number[] = [];
  const stream: ControlStream = {
    recv: {
      readExact: async (size) => {
        reads.push(size);
        const result = frame.subarray(offset, offset + size);
        offset += size;
        return [...result];
      },
      read: async () => [],
    },
    send: {
      writeAll: async () => {
        writes++;
      },
      finish: async () => {},
    },
  };
  const service: FreeExecutionService = {
    respond: async () => parseFreeExecutionResponse(vector.response),
  };
  const enter = () => () => {
    releases++;
  };
  const close = () => {
    closes++;
  };
  return {
    stream,
    service,
    enter,
    close,
    reads,
    writes: () => writes,
    releases: () => releases,
    closes: () => closes,
  };
}
void test('free stream writes one response and applies shared admission before reading', async () => {
  const state = await fixture();
  await serveFreeExecutionStream(
    state.stream,
    state.service,
    'synthetic-peer',
    state.close,
    new AbortController().signal,
    state.enter,
  );
  assert.equal(state.writes(), 1);
  assert.equal(state.releases(), 1);
  const denied = await fixture();
  await serveFreeExecutionStream(
    denied.stream,
    denied.service,
    'peer',
    denied.close,
    new AbortController().signal,
    () => undefined,
  );
  assert.deepEqual(denied.reads, []);
  assert.equal(denied.closes(), 1);
});
void test('free stream rejects huge prefix before requesting the body or invoking policy', async () => {
  const state = await fixture();
  let calls = 0;
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(FREE_EXECUTION.requestBytes + 1);
  state.stream.recv.readExact = async (size) => {
    state.reads.push(size);
    return [...prefix];
  };
  await serveFreeExecutionStream(
    state.stream,
    {
      respond: async (...args) => {
        calls++;
        return state.service.respond(...args);
      },
    },
    'peer',
    state.close,
    new AbortController().signal,
    state.enter,
  );
  assert.deepEqual(state.reads, [4]);
  assert.equal(calls, 0);
  assert.equal(state.closes(), 1);
  assert.equal(state.releases(), 1);
});
void test('free stream deadline suppresses late engine response and retains its permit until settlement', async () => {
  const state = await fixture();
  let settle: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const running = serveFreeExecutionStream(
    state.stream,
    {
      respond: async (...args) => {
        entered!();
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
        return state.service.respond(...args);
      },
    },
    'peer',
    () => {
      state.close();
      closed!();
    },
    new AbortController().signal,
    state.enter,
    () => true,
    { requestMs: 10 },
  );
  await started;
  await stopped;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.releases(), 0);
  settle!();
  await running;
  assert.equal(state.writes(), 0);
  assert.equal(state.releases(), 1);
});
void test('free stream ingress timeout retains a stuck read slot until actual read settlement', async () => {
  const state = await fixture();
  let settle: ((value: number[]) => void) | undefined;
  let readCalls = 0;
  state.stream.recv.readExact = () => {
    readCalls++;
    if (readCalls > 1) return Promise.resolve([]);
    return new Promise((resolve) => {
      settle = resolve;
    });
  };
  let closed: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const running = serveFreeExecutionStream(
    state.stream,
    state.service,
    'peer',
    () => {
      state.close();
      closed!();
    },
    new AbortController().signal,
    state.enter,
    () => true,
    { ingressMs: 10, requestMs: 100 },
  );
  await stopped;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.releases(), 0);
  settle!([0, 0, 0, 10]);
  await running;
  assert.equal(state.writes(), 0);
  assert.equal(state.releases(), 1);
  assert.equal(readCalls, 1);
});

void test('free stream does not finish a response after a timed-out native write settles', async () => {
  const state = await fixture();
  let settle: (() => void) | undefined;
  let finishes = 0;
  state.stream.send.writeAll = () =>
    new Promise<void>((resolve) => {
      settle = resolve;
    });
  state.stream.send.finish = async () => {
    finishes++;
  };
  let closed: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const running = serveFreeExecutionStream(
    state.stream,
    state.service,
    'peer',
    () => {
      state.close();
      closed!();
    },
    new AbortController().signal,
    state.enter,
    () => true,
    { egressMs: 10 },
  );
  await stopped;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.releases(), 0);
  settle!();
  await running;
  assert.equal(finishes, 0);
  assert.equal(state.releases(), 1);
});
