// Verifies the paid stream transport: ordered events under the shared request lease, buyer
// cancellation that stops generation but never settlement, and terminals the wire refuses never
// sent. Frames and the service are synthetic; no engine, sockets or chain.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_EXECUTION_STOP_REASONS } from '@gyblos/protocol/constants';
import {
  paidExecutionDigest,
  type PaidExecutionResponse,
} from '@gyblos/protocol/paid-execution';
import {
  createPaidStreamVerifier,
  decodePaidStreamEvent,
  encodePaidExecutionRequest,
} from '@gyblos/protocol/paid-stream';
import {
  PAID_EXECUTION,
  PAID_EXECUTION_CODES,
  PAID_STREAM,
} from '@gyblos/protocol/paid/constants';
import type { ControlStream } from '@gyblos/transport-iroh/control-io';
import {
  servePaidExecutionStream,
  type PaidExecutionService,
} from '@gyblos/transport-iroh/paid-server';

import { CHARGE, request, RESULT, settled } from './support/paid-fixture';

async function fixture(frame?: Uint8Array) {
  const paid = await request();
  const bytes = frame ?? encodePaidExecutionRequest(paid);
  const terminal: PaidExecutionResponse = {
    version: PAID_EXECUTION.version,
    requestId: paid.requestId,
    requestDigest: await paidExecutionDigest(paid),
    result: RESULT,
    charge: CHARGE,
    payment: settled(paid, CHARGE.chargedAtomic),
  };
  let offset = 0;
  const counts = { released: 0, closed: 0, reads: 0, finished: 0 };
  const frames: unknown[] = [];
  const stream: ControlStream = {
    recv: {
      async readExact(size) {
        counts.reads++;
        const value = bytes.subarray(offset, offset + size);
        offset += size;
        return [...value];
      },
      async read() {
        return [];
      },
    },
    send: {
      async writeAll(written) {
        frames.push(decodePaidStreamEvent(Uint8Array.from(written)));
      },
      async finish() {
        counts.finished++;
      },
    },
  };
  const service: PaidExecutionService = {
    async stream(_request, _peer, _signal, onDelta) {
      await onDelta('Hi');
      await onDelta('.');
      return terminal;
    },
  };
  return {
    paid,
    terminal,
    stream,
    service,
    frames,
    counts,
    close: () => {
      counts.closed++;
    },
    enter: () => () => {
      counts.released++;
    },
  };
}

void test('the paid stream emits ordered deltas then the settled terminal under one lease', async () => {
  const value = await fixture();
  await servePaidExecutionStream(
    value.stream,
    value.service,
    'synthetic',
    value.close,
    new AbortController().signal,
    value.enter,
  );
  assert.equal(value.frames.length, 3);
  const verifier = await createPaidStreamVerifier(value.paid);
  const accepted = [];
  for (const frame of value.frames) accepted.push(await verifier.accept(frame));
  verifier.finish();
  assert.deepEqual(accepted.at(-1), { terminal: value.terminal });
  assert.deepEqual(value.counts, {
    released: 1,
    closed: 0,
    reads: 2,
    finished: 1,
  });
  const denied = await fixture();
  await servePaidExecutionStream(
    denied.stream,
    denied.service,
    'synthetic',
    denied.close,
    new AbortController().signal,
    () => undefined,
  );
  assert.equal(denied.counts.reads, 0);
  assert.equal(denied.counts.closed, 1);
});

void test('a buyer leaving stops generation but the lease waits for settlement', async () => {
  const value = await fixture();
  const controller = new AbortController();
  let settle = () => {};
  let started = () => {};
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const settling = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let settledAfterAbort = false;
  let late: ((text: string) => Promise<void>) | undefined;
  const service: PaidExecutionService = {
    async stream(_request, _peer, signal, onDelta) {
      late = onDelta;
      await onDelta('Hi');
      started();
      await settling;
      assert.equal(signal.aborted, true);
      await assert.rejects(onDelta('.'), {
        code: PAID_EXECUTION_CODES.CANCELLED,
      });
      settledAfterAbort = true;
      return value.terminal;
    },
  };
  const running = servePaidExecutionStream(
    value.stream,
    service,
    'synthetic',
    value.close,
    controller.signal,
    value.enter,
  );
  await entered;
  controller.abort();
  assert.equal(value.counts.closed, 1);
  assert.equal(value.counts.released, 0);
  settle();
  await running;
  assert.equal(settledAfterAbort, true);
  assert.equal(value.counts.released, 1);
  // Only the delta before the buyer left was sent; the terminal had no stream left.
  assert.equal(value.frames.length, 1);
  await assert.rejects(late!('late'), { code: PAID_EXECUTION_CODES.CANCELLED });
});

void test('a terminal the paid wire refuses is never sent', async () => {
  const value = await fixture();
  const { charge: _charge, payment: _payment, ...unpaid } = value.terminal;
  const service: PaidExecutionService = {
    async stream(_request, _peer, _signal, onDelta) {
      await onDelta('Hi.');
      // Delivered text without its charge and payment.
      return unpaid;
    },
  };
  await servePaidExecutionStream(
    value.stream,
    service,
    'synthetic',
    value.close,
    new AbortController().signal,
    value.enter,
  );
  assert.equal(value.frames.length, 1);
  assert.equal(value.counts.closed, 1);
  assert.equal(value.counts.finished, 0);
  assert.equal(value.counts.released, 1);
});

void test('an oversized or malformed request is refused before the service runs', async () => {
  const oversized = new Uint8Array(4);
  new DataView(oversized.buffer).setUint32(0, PAID_EXECUTION.requestBytes + 1);
  const garbage = Uint8Array.from([0, 0, 0, 2, 0x7b, 0x7d]);
  for (const frame of [oversized, garbage]) {
    const value = await fixture(frame);
    let ran = false;
    await servePaidExecutionStream(
      value.stream,
      {
        async stream() {
          ran = true;
          return value.terminal;
        },
      },
      'synthetic',
      value.close,
      new AbortController().signal,
      value.enter,
    );
    assert.equal(ran, false);
    assert.equal(value.frames.length, 0);
    assert.equal(value.counts.closed, 1);
    assert.equal(value.counts.released, 1);
  }
  // The oversized length is refused without reading a body.
  const value = await fixture(oversized);
  await servePaidExecutionStream(
    value.stream,
    value.service,
    'synthetic',
    value.close,
    new AbortController().signal,
    value.enter,
  );
  assert.equal(value.counts.reads, 1);
});

void test('the request deadline aborts generation and closes the stream', async () => {
  const value = await fixture();
  let aborted = false;
  const service: PaidExecutionService = {
    async stream(_request, _peer, signal) {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      aborted = true;
      return value.terminal;
    },
  };
  await servePaidExecutionStream(
    value.stream,
    service,
    'synthetic',
    value.close,
    new AbortController().signal,
    value.enter,
    () => true,
    { requestMs: 20 },
  );
  assert.equal(aborted, true);
  assert.equal(value.counts.closed, 1);
  assert.equal(value.frames.length, 0);
  assert.equal(value.counts.released, 1);
});

void test('a stalled writer is cut by the egress deadline but the lease waits for it', async () => {
  const value = await fixture();
  let unstall = () => {};
  let stopped = () => {};
  const closing = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  value.stream.send.writeAll = () =>
    new Promise<void>((resolve) => {
      unstall = resolve;
    });
  const running = servePaidExecutionStream(
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
  );
  await closing;
  assert.equal(value.counts.released, 0);
  unstall();
  await running;
  assert.equal(value.counts.released, 1);
});

void test('a route revoked mid-stream stops delivery and closes the stream', async () => {
  const value = await fixture();
  let allowed = true;
  let refused: unknown;
  const service: PaidExecutionService = {
    async stream(_request, _peer, _signal, onDelta) {
      await onDelta('Hi');
      allowed = false;
      await onDelta('.').catch((error: unknown) => {
        refused = error;
      });
      return value.terminal;
    },
  };
  await servePaidExecutionStream(
    value.stream,
    service,
    'synthetic',
    value.close,
    new AbortController().signal,
    value.enter,
    () => allowed,
  );
  assert.equal(
    refused instanceof Error && 'code' in refused ? refused.code : undefined,
    PAID_EXECUTION_CODES.PEER,
  );
  assert.equal(value.frames.length, 1);
  assert.equal(value.counts.closed, 1);
  assert.equal(value.counts.released, 1);
});

void test('deltas stop short of the wire limit so the charged terminal still fits', async () => {
  const value = await fixture();
  let limited: unknown;
  const service: PaidExecutionService = {
    async stream(_request, _peer, _signal, onDelta) {
      try {
        // Escaped characters fill the wire long before the output bound.
        for (let index = 0; index < PAID_STREAM.maxEvents; index++)
          await onDelta('\u0000'.repeat(64));
      } catch (error) {
        limited = error;
      }
      const { result: _result, ...stopped } = value.terminal;
      return {
        ...stopped,
        error: {
          code: PAID_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
          reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
          delivered: { outputTokens: 1 },
        },
        charge: { ...CHARGE, outputTokens: 1 },
      };
    },
  };
  await servePaidExecutionStream(
    value.stream,
    service,
    'synthetic',
    value.close,
    new AbortController().signal,
    value.enter,
  );
  assert.equal(
    limited instanceof Error && 'code' in limited ? limited.code : undefined,
    PAID_EXECUTION_CODES.LIMIT,
  );
  const last = value.frames.at(-1);
  assert.ok(last && typeof last === 'object' && 'response' in last);
  assert.equal(value.counts.closed, 0);
  assert.equal(value.counts.finished, 1);
});
