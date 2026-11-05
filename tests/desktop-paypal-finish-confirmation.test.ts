// Exercises close confirmation and agent races with in-memory sandbox fixtures.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

async function setupAgent(generate: () => Promise<void>) {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      f.calls.push('agent-generate');
      await generate();
      return {
        id: 'synthetic',
        object: 'chat.completion',
        created: 0,
        model: 'synthetic-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'synthetic answer' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      };
    },
  };
  const desktop = createDesktopPaypalSession(
    await createPaypalSession({ ...f, agentEngine }),
    async () => {},
  );
  await desktop.create();
  await desktop.approve();
  const request = {
    model: agentEngine.model,
    messages: [{ role: 'user', content: 'synthetic request' }],
    max_tokens: 128,
  };
  return { f, desktop, request };
}

void test('an agent already running prevents close confirmation until it finishes', async () => {
  const entered = latch();
  const waiting = latch();
  const { f, desktop, request } = await setupAgent(async () => {
    entered.release();
    await waiting.promise;
  });
  let confirmations = 0;
  const inference = desktop.sendAgent(request);
  await entered.promise;
  try {
    await assert.rejects(
      desktop.finishWithConfirmation(async () => {
        confirmations += 1;
        return true;
      }),
    );
  } finally {
    waiting.release();
  }
  await inference;
  assert.equal(confirmations, 0);
  assert.equal(desktop.status().spentCents, 10);
  await desktop.finishWithConfirmation(async (summary) => {
    assert.equal(summary.spentCents, 10);
    return true;
  });
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'agent-generate',
    'capture:10',
  ]);
});

void test('an agent cannot start while the close confirmation is open', async () => {
  const entered = latch();
  const waiting = latch();
  const { f, desktop, request } = await setupAgent(async () => {});
  const finishing = desktop.finishWithConfirmation(async () => {
    entered.release();
    await waiting.promise;
    return true;
  });
  await entered.promise;
  try {
    await assert.rejects(desktop.sendAgent(request));
  } finally {
    waiting.release();
  }
  assert.equal((await finishing).phase, 'voided');
  assert.deepEqual(f.calls, ['create', 'authorize', 'void']);
});

void test('closing the desktop during confirmation never dispatches settlement', async () => {
  const entered = latch();
  const waiting = latch();
  const { f, desktop } = await setupAgent(async () => {});
  const finishing = desktop.finishWithConfirmation(async () => {
    entered.release();
    await waiting.promise;
    return true;
  });
  await entered.promise;
  const closing = desktop.close();
  waiting.release();
  assert.equal((await finishing).phase, 'active');
  await closing;
  assert.deepEqual(f.calls, ['create', 'authorize']);
});

void test('an uncertain capture stays blocked after a confirmed close', async () => {
  const { f, desktop } = await setupAgent(async () => {});
  const answer = await desktop.send('synthetic');
  await desktop.acknowledge(answer.messageId);
  f.payment.capture = async () => {
    f.calls.push('capture-uncertain');
    throw new Error('synthetic timeout');
  };
  await assert.rejects(desktop.finishWithConfirmation(async () => true));
  await assert.rejects(desktop.finishWithConfirmation(async () => true));
  assert.equal(
    f.calls.filter((entry) => entry === 'capture-uncertain').length,
    1,
  );
});
