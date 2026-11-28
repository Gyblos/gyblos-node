import assert from 'node:assert/strict';
import test from 'node:test';

import {
  frameOf,
  readStream,
  type ReplayTiming,
} from '../../lab/tools/agent-replay/client';
import {
  summarize,
  type ReplayRecord,
} from '../../lab/tools/agent-replay/report';

const base: ReplayRecord = {
  tag: 'replay-request-1',
  role: 'main',
  turn: 1,
  startMs: 0,
  headersMs: 10,
  firstTokenMs: 20,
  totalMs: 30,
  status: 200,
  code: null,
  sellerCount: 1,
  traced: true,
  admissionMs: 2,
  sellers: [1],
  waitsMs: [5],
};

void test('a stream that emits text and then an error is a failure, not a served request', () => {
  const summary = summarize([
    base,
    { ...base, tag: 'replay-request-2', code: 'SELLER_FAILED', totalMs: 900 },
  ]);
  assert.equal(summary.served, 1);
  assert.deepEqual(summary.failures, { '200:SELLER_FAILED': 1 });
  assert.equal(summary.totalMs.p95, 30);
  assert.equal(summary.admissionMs.p95, 2);
  assert.equal(summary.failedTotalMs.p95, 900);
});

void test('stream frames are validated before use', () => {
  assert.deepEqual(frameOf('data: {"choices":[{"delta":{"content":"hi"}}]}'), {
    text: 'hi',
    error: undefined,
  });
  assert.deepEqual(frameOf('data: {"choices":[{"delta":{"content":7}}]}'), {
    text: '',
    error: undefined,
  });
  assert.equal(frameOf('data: {"error":{"code":"BUSY"}}').error, 'BUSY');
  assert.equal(frameOf('data: {"error":{"code":3}}').error, 'gyblos_error');
  assert.deepEqual(frameOf('data: [DONE]'), {});
});

void test('a stream that sends text and then an error frame keeps its first token and records the error', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"error":{"code":"SELLER_FAILED"}}\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames)
        controller.enqueue(new TextEncoder().encode(frame));
      controller.close();
    },
  });
  const timing: ReplayTiming = {
    tag: 'replay-request-1',
    role: 'main',
    turn: 1,
    startMs: 0,
    headersMs: 0,
    firstTokenMs: null,
    totalMs: 0,
    status: 200,
    code: null,
    text: '',
  };
  await readStream(body, 0, timing);
  assert.equal(timing.text, 'partial');
  assert.notEqual(timing.firstTokenMs, null);
  assert.equal(timing.code, 'SELLER_FAILED');
});
