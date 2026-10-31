import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalInference } from '@gyblos/node/paypal-inference';
import { validatePaypalPrompt } from '@gyblos/node/paypal-startup';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

function fixture() {
  const calls: string[] = [];
  let state: unknown = null;
  const payment = {
    async prepare() {},
    async isApproved() {
      return true;
    },
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
    async refund() {
      calls.push('refund');
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

void test('unapproved orders and failed credentials do not permanently block a new attempt', async () => {
  const f = fixture();
  f.payment.prepare = async () => {
    throw new Error('credentials');
  };
  const service = await createPaypalInference(f);
  await assert.rejects(service.create('first', 16));
  f.payment.prepare = async () => {};
  await service.create('first', 16);
  f.payment.isApproved = async () => false;
  await assert.rejects(service.execute('ORDER1', 'first', 16));
  f.payment.isApproved = async () => true;
  await service.execute('ORDER1', 'first', 16);
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture']);
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
    phase: 'completed',
    promptDigest: 'a'.repeat(64),
    maxTokens: 16,
  });
  await assert.rejects(createPaypalInference(f));
  f.journal.read = async () => ({
    phase: 'completed',
    promptDigest: 'a'.repeat(64),
    maxTokens: 16,
    orderId: '',
    authorizationId: 'AUTH1',
    captureId: 'CAPTURE1',
  });
  await assert.rejects(createPaypalInference(f));
  assert.deepEqual(f.calls, []);
});

void test('an order that was never authorized may be abandoned after a restart', async () => {
  const f = fixture();
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  const restarted = await createPaypalInference(f);
  await restarted.cancel();
  await restarted.create('second', 16);
  assert.deepEqual(f.calls, ['create', 'create']);
});

void test('engine-incompatible input is rejected before contacting PayPal', async () => {
  const f = fixture();
  const service = await createPaypalInference({
    ...f,
    validateRequest() {
      throw new Error('unsupported prompt');
    },
  });
  await assert.rejects(service.create('invalid', 16));
  assert.deepEqual(f.calls, []);
  assert.equal(f.getState(), null);
});

void test('buyer disconnect before capture voids the authorization', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.engine.generate = async () => {
    f.calls.push('generate');
    controller.abort();
    return { text: 'answer', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(
    service.execute('ORDER1', 'first', 16, controller.signal),
  );
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'void']);
});

void test('buyer disconnect during capture refunds the completed payment', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.payment.capture = async () => {
    f.calls.push('capture');
    controller.abort();
    return { captureId: 'CAPTURE1' };
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(
    service.execute('ORDER1', 'first', 16, controller.signal),
  );
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'capture',
    'refund',
  ]);
});

void test('uncertain refund stays blocked after restart', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.payment.capture = async () => {
    controller.abort();
    return { captureId: 'CAPTURE1' };
  };
  f.payment.refund = async () => {
    throw new Error('timeout');
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(
    service.execute('ORDER1', 'first', 16, controller.signal),
  );
  const restarted = await createPaypalInference(f);
  await assert.rejects(restarted.create('second', 16));
});

void test('order creation records a request id before contacting PayPal', async () => {
  const f = fixture();
  f.payment.create = async () => {
    const state = f.getState();
    assert.ok(state && typeof state === 'object' && 'requestId' in state);
    const requestId = Reflect.get(state, 'requestId');
    assert.equal(typeof requestId, 'string');
    if (typeof requestId !== 'string') throw new Error('Missing request id');
    assert.match(requestId, /^[0-9a-f-]{36}$/);
    return {
      orderId: 'ORDER1',
      approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
    };
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
});

void test('disconnect during capture preparation voids before sending a capture', async () => {
  const f = fixture();
  const controller = new AbortController();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    await write(value);
    if (JSON.stringify(value).includes('capturing')) controller.abort();
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(
    service.execute('ORDER1', 'first', 16, controller.signal),
  );
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'void']);
});

void test('disconnect while recording completion triggers a refund', async () => {
  const f = fixture();
  const controller = new AbortController();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    await write(value);
    if (JSON.stringify(value).includes('completed')) controller.abort();
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  await assert.rejects(
    service.execute('ORDER1', 'first', 16, controller.signal),
  );
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'capture',
    'refund',
  ]);
});

void test('contradictory terminal journal fields cannot unlock payments', async () => {
  const f = fixture();
  const base = {
    requestId: 'REQUEST1',
    promptDigest: 'a'.repeat(64),
    maxTokens: 16,
    orderId: 'ORDER1',
  };
  f.journal.read = async () => ({
    ...base,
    phase: 'cancelled',
    authorizationId: 'AUTH1',
  });
  await assert.rejects(createPaypalInference(f));
  f.journal.read = async () => ({
    ...base,
    phase: 'voided',
    authorizationId: 'AUTH1',
    captureId: 'CAPTURE1',
  });
  await assert.rejects(createPaypalInference(f));
});

void test('a refund holds the payment lock until its final journal write completes', async () => {
  const f = fixture();
  const controller = new AbortController();
  let release = () => {};
  let notify = () => {};
  const entered = new Promise<void>((resolve) => { notify = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    if (JSON.stringify(value).includes('refunded')) { notify(); await hold; }
    await write(value);
  };
  f.payment.capture = async () => { f.calls.push('capture'); controller.abort(); return { captureId: 'CAPTURE1' }; };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  const execution = service.execute('ORDER1', 'first', 16, controller.signal);
  const finished = assert.rejects(execution);
  await entered;
  try { await assert.rejects(service.create('second', 16)); }
  finally { release(); await finished; }
});

void test('a refund after completion recording also holds the payment lock', async () => {
  const f = fixture();
  const controller = new AbortController();
  let release = () => {};
  let notify = () => {};
  const entered = new Promise<void>((resolve) => { notify = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    if (JSON.stringify(value).includes('completed')) controller.abort();
    if (JSON.stringify(value).includes('refunded')) { notify(); await hold; }
    await write(value);
  };
  const service = await createPaypalInference(f);
  await service.create('first', 16);
  const finished = assert.rejects(service.execute('ORDER1', 'first', 16, controller.signal));
  await entered;
  try { await assert.rejects(service.create('second', 16)); }
  finally { release(); await finished; }
});

void test('the real engine preflight reports unsupported prompts with a typed code', () => {
  assert.throws(() => validatePaypalPrompt('<think>bad</think>', 16),
    (error: unknown) => error instanceof PaypalError && error.code === PAYPAL_ERROR_CODES.INVALID_REQUEST);
});
