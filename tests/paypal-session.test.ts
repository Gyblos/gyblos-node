import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';

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
    async capture(_id: string, cents?: number) {
      calls.push(`capture:${cents}`);
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
        text: 'a synthetic answer',
        usage: { inputTokens: 2, outputTokens: 3 },
      };
    },
  };
  return {
    calls,
    payment,
    journal,
    engine,
    getState: () => state,
    setState(value: unknown) {
      state = value;
    },
  };
}

async function start(f: ReturnType<typeof fixture>) {
  const service = await createPaypalSession(f);
  const order = await service.create();
  await service.approve(order.orderId);
  return service;
}

void test('one approval pays for multiple acknowledged messages with one partial capture', async () => {
  const f = fixture();
  const session = await start(f);
  for (const prompt of ['first synthetic prompt', 'second synthetic prompt']) {
    const result = await session.message(prompt, 16);
    assert.equal(result.text, 'a synthetic answer');
    await session.acknowledge(result.messageId);
  }
  const result = await session.finish();
  assert.equal(result.spentCents, 20);
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'generate',
    'capture:20',
  ]);
  assert.doesNotMatch(
    JSON.stringify(f.getState()),
    /synthetic (prompt|answer)/,
  );
});

void test('the authorized ceiling allows ten messages and rejects the eleventh', async () => {
  const f = fixture();
  const session = await start(f);
  for (let i = 0; i < 10; i += 1) {
    const result = await session.message(`message ${i}`, 16);
    await session.acknowledge(result.messageId);
  }
  await assert.rejects(session.message('over limit', 16));
  await session.finish();
  assert.equal(f.calls.filter((call) => call === 'generate').length, 10);
  assert.equal(f.calls.at(-1), 'capture:100');
});

void test('an inference failure does not void previous successful messages', async () => {
  const f = fixture();
  const session = await start(f);
  const first = await session.message('one', 16);
  await session.acknowledge(first.messageId);
  f.engine.generate = async () => {
    f.calls.push('generate');
    throw new Error('engine');
  };
  await assert.rejects(session.message('two', 16));
  await session.finish();
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'generate',
    'capture:10',
  ]);
});

void test('closing an unused authorization voids it without capture', async () => {
  const f = fixture();
  const session = await start(f);
  assert.equal((await session.finish()).spentCents, 0);
  assert.deepEqual(f.calls, ['create', 'authorize', 'void']);
});

void test('an unacknowledged result cannot be captured or followed by another inference', async () => {
  const f = fixture();
  const session = await start(f);
  const result = await session.message('one', 16);
  await assert.rejects(session.finish());
  await assert.rejects(session.message('two', 16));
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.finish());
  await assert.rejects(restarted.acknowledge('OTHER'));
  await restarted.acknowledge(result.messageId);
  await restarted.finish();
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture:10']);
});

void test('uncertain capture is not retried, even after restart', async () => {
  const f = fixture();
  f.payment.capture = async () => {
    f.calls.push('capture');
    throw new Error('timeout');
  };
  const session = await start(f);
  const result = await session.message('one', 16);
  await session.acknowledge(result.messageId);
  await assert.rejects(session.finish());
  await assert.rejects(session.finish());
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.finish());
  await assert.rejects(restarted.create());
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture']);
});

void test('legacy unfinished payment blocks a new session; a valid finished one permits it', async () => {
  const f = fixture();
  const legacy = {
    phase: 'capturing',
    requestId: 'REQUEST1',
    promptDigest: 'a'.repeat(64),
    maxTokens: 16,
    orderId: 'ORDER1',
    authorizationId: 'AUTH1',
  };
  f.setState(legacy);
  const blocked = await createPaypalSession(f);
  await assert.rejects(blocked.create());
  assert.deepEqual(f.calls, []);
  f.setState({ ...legacy, phase: 'completed', captureId: 'CAPTURE1' });
  const finished = await createPaypalSession(f);
  await finished.create();
  assert.deepEqual(f.calls, ['create']);
});

void test('a failed write before returning an answer blocks continued use after restart', async () => {
  const f = fixture();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    if (JSON.stringify(value).includes('message_pending'))
      throw new Error('disk');
    await write(value);
  };
  const session = await start(f);
  await assert.rejects(session.message('one', 16));
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.finish());
  await assert.rejects(restarted.message('two', 16));
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate']);
});

void test('only one message can run at a time', async () => {
  const f = fixture();
  let release = () => {};
  let notify = () => {};
  const entered = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.engine.generate = async () => {
    f.calls.push('generate');
    notify();
    await wait;
    return { text: 'answer', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const session = await start(f);
  const first = session.message('one', 16);
  await entered;
  try {
    await assert.rejects(session.message('two', 16));
    await assert.rejects(session.finish());
  } finally {
    release();
  }
  const result = await first;
  await session.acknowledge(result.messageId);
  await session.finish();
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture:10']);
});

void test('a disconnected message does not charge or void previous usage', async () => {
  const f = fixture();
  const session = await start(f);
  const first = await session.message('one', 16);
  await session.acknowledge(first.messageId);
  const controller = new AbortController();
  f.engine.generate = async () => {
    f.calls.push('generate');
    controller.abort();
    return { text: 'lost', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  await assert.rejects(session.message('two', 16, controller.signal));
  await session.finish();
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'generate',
    'capture:10',
  ]);
});

void test('an expired session rejects new messages but can be closed', async () => {
  const f = fixture();
  await start(f);
  const state = f.getState();
  assert.ok(state && typeof state === 'object');
  f.setState({ ...state, expiresAt: 1 });
  const expired = await createPaypalSession(f);
  await assert.rejects(expired.message('late', 16));
  await expired.finish();
  assert.deepEqual(f.calls, ['create', 'authorize', 'void']);
});

void test('a corrupted session journal cannot unlock another payment', async () => {
  const f = fixture();
  f.setState({
    version: 2,
    phase: 'completed',
    requestId: 'REQUEST1',
    spentCents: 10,
    orderId: 'ORDER1',
    authorizationId: 'AUTH1',
    expiresAt: 1,
  });
  await assert.rejects(createPaypalSession(f));
  f.setState({
    version: 2,
    phase: 'active',
    requestId: 'REQUEST1',
    spentCents: 110,
    orderId: 'ORDER1',
    authorizationId: 'AUTH1',
    expiresAt: 1,
  });
  await assert.rejects(createPaypalSession(f));
  assert.deepEqual(f.calls, []);
});
