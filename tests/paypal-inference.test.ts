import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalInference } from '@gyblos/node/paypal-inference';

function fixture() {
  const calls: string[] = [];
  let state: unknown = null;
  const payment = {
    async create() {
      calls.push('create');
      return {
        orderId: 'ORDER1',
        approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
      };
    },
    async authorize() {
      calls.push('authorize');
      return { authorizationId: 'AUTH1' };
    },
    async capture() {
      calls.push('capture');
      return { captureId: 'CAPTURE1' };
    },
    async void() {
      calls.push('void');
    },
  };
  const journal = {
    async read() {
      return state;
    },
    async write(value: unknown) {
      state = structuredClone(value);
    },
  };
  const engine = {
    async generate() {
      calls.push('generate');
      return {
        text: 'A synthetic answer',
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    },
  };
  return { calls, payment, journal, engine, getState: () => state };
}

void test('a PayPal authorization pays for one bound inference and is captured once', async () => {
  const f = fixture();
  const service = await createPaypalInference(f);
  const order = await service.create('A synthetic prompt', 16);
  assert.equal(order.orderId, 'ORDER1');
  const answer = await service.execute(order.orderId, 'A synthetic prompt', 16);
  assert.equal(answer.text, 'A synthetic answer');
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture']);
  await assert.rejects(
    service.execute(order.orderId, 'A synthetic prompt', 16),
  );
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture']);
  assert.doesNotMatch(
    JSON.stringify(f.getState()),
    /A synthetic (prompt|answer)/,
  );
});

void test('a different prompt cannot use the approved order', async () => {
  const f = fixture();
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(service.execute('ORDER1', 'second', 16));
  assert.deepEqual(f.calls, ['create']);
});

void test('engine failure voids the authorization and never captures', async () => {
  const f = fixture();
  f.engine.generate = async () => {
    f.calls.push('generate');
    throw new Error('engine');
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(service.execute('ORDER1', 'first', 16));
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'void']);
});

void test('uncertain capture blocks another attempt, including after restart', async () => {
  const f = fixture();
  f.payment.capture = async () => {
    f.calls.push('capture');
    throw new Error('timeout');
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(service.execute('ORDER1', 'first', 16));
  await assert.rejects(service.create('second', 16));
  const restarted = await createPaypalInference(f);
  await assert.rejects(restarted.create('second', 16));
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture']);
});

void test('a journal failure after capture blocks further orders', async () => {
  const f = fixture();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    if (JSON.stringify(value).includes('completed')) throw new Error('disk');
    await write(value);
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(service.execute('ORDER1', 'first', 16));
  await assert.rejects(service.create('second', 16));
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture']);
});

void test('a corrupt terminal journal cannot unblock another payment', async () => {
  const f = fixture();
  f.journal.read = async () => ({
    phase: 'completed', promptDigest: 'a'.repeat(64), maxTokens: 16,
  });
  await assert.rejects(createPaypalInference(f));
  assert.deepEqual(f.calls, []);
});
