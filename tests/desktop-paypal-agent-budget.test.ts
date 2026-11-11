// Synthetic local keys exercise admission without PayPal, wallets or real inference.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startDesktopPaypalAgent } from '@gyblos/desktop/paypal-agent-server';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

async function budgetFixture() {
  const f = fixture();
  let generated = 0;
  const model = 'synthetic-model';
  const agentEngine = {
    model,
    async generate() {
      generated += 1;
      return {
        id: 'synthetic',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'synthetic' },
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
  return { f, desktop, model, generated: () => generated };
}
function call(
  agent: Awaited<ReturnType<typeof startDesktopPaypalAgent>>,
  model: string,
  operation: string,
) {
  return fetch(`${agent.url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${agent.key}`,
      'content-type': 'application/json',
      'idempotency-key': operation,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'synthetic request' }],
      max_tokens: 128,
    }),
  });
}

void test('an API key stops at its own cap while Chat keeps the shared session remainder', async () => {
  const { desktop, model, generated } = await budgetFixture();
  const agent = await startDesktopPaypalAgent(desktop, model, 20);
  try {
    const chat = await desktop.send('synthetic chat');
    await desktop.acknowledge(chat.messageId);
    assert.equal((await call(agent, model, 'operation-1')).status, 200);
    assert.equal((await call(agent, model, 'operation-2')).status, 200);
    const refused = await call(agent, model, 'operation-3');
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /PAYPAL_KEY_LIMIT_REACHED/);
    assert.equal(refused.headers.get('x-should-retry'), 'false');
    assert.equal(generated(), 2);
    assert.equal(desktop.status().spentCents, 30);
    const nextChat = await desktop.send('another synthetic chat');
    await desktop.acknowledge(nextChat.messageId);
    assert.equal(desktop.status().spentCents, 40);
  } finally {
    await agent.close();
    await desktop.close();
  }
});

void test('a newly granted API cap excludes older agent usage and cannot bypass the session cap', async () => {
  const { desktop, model, generated } = await budgetFixture();
  const first = await startDesktopPaypalAgent(desktop, model, 10);
  try {
    assert.equal((await call(first, model, 'first-key')).status, 200);
  } finally {
    await first.close();
  }
  const second = await startDesktopPaypalAgent(desktop, model, 90);
  try {
    for (let index = 0; index < 9; index += 1)
      assert.equal(
        (await call(second, model, `second-key-${index}`)).status,
        200,
      );
    assert.equal((await call(second, model, 'over-cap')).status, 400);
    assert.equal(generated(), 10);
    assert.equal(desktop.status().spentCents, 100);
  } finally {
    await second.close();
    await desktop.close();
  }
});

void test('invalid API budgets are rejected before a key is created', async () => {
  const { desktop, model } = await budgetFixture();
  try {
    for (const limit of [
      0,
      -10,
      9,
      15,
      101,
      110,
      10.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER,
    ]) {
      let opened:
        Awaited<ReturnType<typeof startDesktopPaypalAgent>> | undefined;
      try {
        await assert.rejects(async () => {
          opened = await startDesktopPaypalAgent(desktop, model, limit);
        });
      } finally {
        await opened?.close();
      }
    }
  } finally {
    await desktop.close();
  }
});
