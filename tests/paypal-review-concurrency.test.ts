import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openPaypalJournal } from '@gyblos/node/paypal-journal';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('the journal cannot close or create a second owner while inference is still running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'paypal-review-inflight-'));
  let resume: () => void = () => {};
  try {
    const journal = await openPaypalJournal(root);
    const f = fixture();
    let reached: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const agentEngine = {
      model: 'synthetic-model',
      async generate() {
        reached();
        await paused;
        return {
          id: 'synthetic',
          object: 'chat.completion',
          created: 0,
          model: 'synthetic-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'synthetic' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
      },
    };
    const session = await createPaypalSession({ ...f, journal, agentEngine });
    const order = await session.create();
    await session.approve(order.orderId);
    const pending = session.agentMessage(
      order.orderId,
      {
        model: 'synthetic-model',
        messages: [{ role: 'user', content: 'synthetic' }],
        max_tokens: 16,
      },
      'AGENT1',
    );
    await started;
    const closeBlocked = await journal.close().then(
      () => false,
      () => true,
    );
    const secondBlocked = await createPaypalSession({ ...f, journal }).then(
      () => false,
      () => true,
    );
    resume();
    await pending.catch(() => {});
    assert.equal(closeBlocked, true);
    assert.equal(secondBlocked, true);
    assert.equal(session.status().phase, 'active');
    assert.equal(session.status().spentCents, 10);
    await journal.close();
  } finally {
    resume();
    await rm(root, { recursive: true, force: true });
  }
});
