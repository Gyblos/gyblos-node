import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPaypalSession } from '@gyblos/node/paypal-session';
import { PAYPAL_ERROR_CODES } from '@gyblos/protocol/constants';
import { PaypalError } from '@gyblos/protocol/paypal-payment';

import { fixture, start } from './support/paypal-session-fixture';

void test('a contradictory order response blocks abandonment and new orders across restart', async () => {
  const f = fixture();
  f.payment.isApproved = async () => {
    throw new PaypalError(PAYPAL_ERROR_CODES.INVALID_RESPONSE);
  };
  const session = await createPaypalSession(f);
  await session.create();
  await assert.rejects(session.approve('ORDER1'));
  assert.equal(session.status().phase, 'review');
  await assert.rejects(session.cancel('ORDER1'));
  await assert.rejects(session.create());
  const restarted = await createPaypalSession(f);
  assert.equal(restarted.status().phase, 'review');
  await assert.rejects(restarted.cancel('ORDER1'));
  await assert.rejects(restarted.create());
  await assert.rejects(restarted.approve('ORDER1'));
  assert.deepEqual(f.calls, ['create']);
});

void test('an invalid checkout return state cannot write a journal or contact PayPal', async () => {
  const f = fixture();
  let prepared = 0;
  f.payment.prepare = async () => {
    prepared += 1;
  };
  const session = await createPaypalSession(f);
  await assert.rejects(session.create('invalid'));
  assert.equal(f.getState(), null);
  assert.equal(prepared, 0);
  assert.deepEqual(f.calls, []);
});

void test('one approval pays for multiple acknowledged messages with one partial capture', async () => {
  const f = fixture();
  const session = await start(f);
  for (const [index, prompt] of [
    'first synthetic prompt',
    'second synthetic prompt',
  ].entries()) {
    const result = await session.message(
      'ORDER1',
      prompt,
      16,
      `MESSAGE${index}`,
    );
    assert.equal(result.text, 'a synthetic answer');
    await session.acknowledge('ORDER1', result.messageId);
  }
  const result = await session.finish('ORDER1');
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
    const result = await session.message(
      'ORDER1',
      `message ${i}`,
      16,
      `MESSAGE${i}`,
    );
    await session.acknowledge('ORDER1', result.messageId);
  }
  await assert.rejects(session.message('ORDER1', 'over limit', 16, 'OVER'));
  await session.finish('ORDER1');
  assert.equal(f.calls.filter((call) => call === 'generate').length, 10);
  assert.equal(f.calls.at(-1), 'capture:100');
});

void test('an uncertain engine failure preserves previous usage without voiding or capturing', async () => {
  const f = fixture();
  const session = await start(f);
  const first = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', first.messageId);
  f.engine.generate = async () => {
    f.calls.push('generate');
    throw new Error('engine');
  };
  await assert.rejects(session.message('ORDER1', 'two', 16, 'MESSAGE2'));
  await assert.rejects(session.finish('ORDER1'));
  assert.equal(session.status().spentCents, 10);
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'generate']);
});

void test('closing an unused authorization voids it without capture', async () => {
  const f = fixture();
  const session = await start(f);
  assert.equal((await session.finish('ORDER1')).spentCents, 0);
  assert.deepEqual(f.calls, ['create', 'authorize', 'void']);
});

void test('an unacknowledged result cannot be captured or followed by another inference', async () => {
  const f = fixture();
  const session = await start(f);
  const result = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await assert.rejects(session.finish('ORDER1'));
  await assert.rejects(session.message('ORDER1', 'two', 16, 'MESSAGE2'));
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.finish('ORDER1'));
  await assert.rejects(restarted.acknowledge('ORDER1', 'OTHER'));
  await restarted.acknowledge('ORDER1', result.messageId);
  await restarted.finish('ORDER1');
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture:10']);
});

void test('uncertain capture is not retried, even after restart', async () => {
  const f = fixture();
  f.payment.capture = async () => {
    f.calls.push('capture');
    throw new Error('timeout');
  };
  const session = await start(f);
  const result = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', result.messageId);
  await assert.rejects(session.finish('ORDER1'));
  await assert.rejects(session.finish('ORDER1'));
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.finish('ORDER1'));
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
  await assert.rejects(session.message('ORDER1', 'one', 16, 'MESSAGE1'));
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.finish('ORDER1'));
  await assert.rejects(restarted.message('ORDER1', 'two', 16, 'MESSAGE2'));
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
  const first = session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await entered;
  try {
    await assert.rejects(session.message('ORDER1', 'two', 16, 'MESSAGE2'));
    await assert.rejects(session.finish('ORDER1'));
  } finally {
    release();
  }
  const result = await first;
  await session.acknowledge('ORDER1', result.messageId);
  await session.finish('ORDER1');
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture:10']);
});

void test('a disconnected in-flight message blocks settlement pending reconciliation', async () => {
  const f = fixture();
  const session = await start(f);
  const first = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', first.messageId);
  const controller = new AbortController();
  f.engine.generate = async () => {
    f.calls.push('generate');
    controller.abort();
    return { text: 'lost', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  await assert.rejects(
    session.message('ORDER1', 'two', 16, 'MESSAGE2', controller.signal),
  );
  await assert.rejects(session.finish('ORDER1'));
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.message('ORDER1', 'two', 16, 'MESSAGE2'));
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'generate']);
});

void test('an expired session rejects new messages but can be closed', async () => {
  const f = fixture();
  await start(f);
  const state = f.getState();
  assert.ok(state && typeof state === 'object');
  f.setState({ ...state, expiresAt: 1 });
  const expired = await createPaypalSession(f);
  await assert.rejects(expired.message('ORDER1', 'late', 16, 'LATE'));
  await expired.finish('ORDER1');
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

void test('a repeated message identifier cannot generate or charge twice after an acknowledgment is lost', async () => {
  const f = fixture();
  const session = await start(f);
  const response = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', response.messageId);
  const restarted = await createPaypalSession(f);
  await restarted.acknowledge('ORDER1', 'MESSAGE1');
  await assert.rejects(restarted.message('ORDER1', 'one', 16, 'MESSAGE1'));
  await assert.rejects(
    restarted.message('ORDER1', 'different input', 16, 'MESSAGE1'),
  );
  await restarted.finish('ORDER1');
  assert.deepEqual(f.calls, ['create', 'authorize', 'generate', 'capture:10']);
});

void test('a journal failure after capture reports blocked rather than completed', async () => {
  const f = fixture();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    if (JSON.stringify(value).includes('completed')) throw new Error('disk');
    await write(value);
  };
  const session = await start(f);
  const result = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', result.messageId);
  await assert.rejects(session.finish('ORDER1'));
  assert.equal(session.status().phase, 'blocked');
  const restarted = await createPaypalSession(f);
  await assert.rejects(restarted.finish('ORDER1'));
});

void test('disconnect during pending write releases that undelivered attempt but preserves earlier usage', async () => {
  const f = fixture();
  const session = await start(f);
  const first = await session.message('ORDER1', 'one', 16, 'MESSAGE1');
  await session.acknowledge('ORDER1', first.messageId);
  const controller = new AbortController();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    await write(value);
    if (JSON.stringify(value).includes('message_pending')) controller.abort();
  };
  await assert.rejects(
    session.message('ORDER1', 'two', 16, 'MESSAGE2', controller.signal),
  );
  await assert.rejects(session.message('ORDER1', 'two', 16, 'MESSAGE2'));
  await session.finish('ORDER1');
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'generate',
    'capture:10',
  ]);
});

void test('undelivered attempts are remembered and bounded without consuming the authorization', async () => {
  const f = fixture();
  const session = await start(f);
  let controller = new AbortController();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    await write(value);
    if (JSON.stringify(value).includes('message_pending')) controller.abort();
  };
  for (let i = 0; i < 30; i += 1) {
    controller = new AbortController();
    await assert.rejects(
      session.message('ORDER1', 'one', 16, `ATTEMPT${i}`, controller.signal),
    );
  }
  assert.equal(session.status().remainingAttempts, 0);
  await assert.rejects(session.message('ORDER1', 'one', 16, 'ATTEMPT30'));
  await session.finish('ORDER1');
  assert.equal(f.calls.filter((call) => call === 'generate').length, 30);
  assert.equal(f.calls.at(-1), 'void');
  const restarted = await createPaypalSession(f);
  await restarted.create();
});
