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

void test('all API formats share one key budget and model discovery stays free', async () => {
  const { desktop, model, generated } = await budgetFixture();
  const agent = await startDesktopPaypalAgent(desktop, model, 20);
  const headers = {
    authorization: `Bearer ${agent.key}`,
    'content-type': 'application/json',
  };
  try {
    assert.equal((await call(agent, model, 'tool-one')).status, 200);
    const responses = await fetch(`${agent.url}/responses`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'tool-two' },
      body: JSON.stringify({
        model,
        input: 'synthetic response request',
        max_output_tokens: 128,
      }),
    });
    assert.equal(responses.status, 200, await responses.text());
    const messages = await fetch(`${agent.url}/messages`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'tool-three' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'synthetic anthropic request' }],
        max_tokens: 128,
      }),
    });
    assert.equal(messages.status, 400);
    assert.match(await messages.text(), /PAYPAL_KEY_LIMIT_REACHED/);
    assert.equal((await fetch(`${agent.url}/models`, { headers })).status, 200);
    assert.deepEqual(agent.budget(), { keyLimitCents: 20, keySpentCents: 20 });
    assert.equal(generated(), 2);
  } finally {
    await agent.close();
    await desktop.close();
  }
});

void test('duplicates and invalid requests do not consume an API key budget', async () => {
  const { desktop, model, generated } = await budgetFixture();
  const agent = await startDesktopPaypalAgent(desktop, model, 20);
  try {
    assert.equal((await call(agent, model, 'same-operation')).status, 200);
    const duplicate = await call(agent, model, 'same-operation');
    assert.equal(duplicate.status, 400);
    assert.match(await duplicate.text(), /PAYPAL_DUPLICATE_REQUEST/);
    const malformed = await fetch(`${agent.url}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${agent.key}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(agent.budget(), { keyLimitCents: 20, keySpentCents: 10 });
    assert.equal(generated(), 1);
    assert.equal((await call(agent, model, 'new-operation')).status, 200);
  } finally {
    await agent.close();
    await desktop.close();
  }
});

void test('grant admission rejects a cancelled request and an old session scope', async () => {
  const { desktop, model, generated } = await budgetFixture();
  const grant = await desktop.createAgentGrant(20);
  try {
    const abort = new AbortController();
    abort.abort();
    const input = {
      model,
      messages: [{ role: 'user', content: 'synthetic' }],
      max_tokens: 128,
    };
    await assert.rejects(grant.sendAgent(input, abort.signal, 'cancelled'));
    assert.equal(generated(), 0);
    assert.equal(grant.budget().keySpentCents, 0);
    await desktop.finish();
    await desktop.create();
    await desktop.approve();
    await assert.rejects(
      grant.sendAgent(input, undefined, 'old-scope'),
      /PAYPAL_NEEDS_RECONCILIATION/,
    );
    assert.equal(generated(), 0);
  } finally {
    await desktop.close();
  }
});

void test('an uncertain completion stays blocked without resetting the key grant', async () => {
  const { desktop, model, f, generated } = await budgetFixture();
  const grant = await desktop.createAgentGrant(20);
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      'agentCompletions' in value &&
      Array.isArray(value.agentCompletions) &&
      value.agentCompletions.length > 0
    )
      throw new Error('synthetic write failure');
    await write(value);
  };
  try {
    const input = {
      model,
      messages: [{ role: 'user', content: 'synthetic' }],
      max_tokens: 128,
    };
    await assert.rejects(grant.sendAgent(input, undefined, 'uncertain'));
    assert.equal(desktop.status().phase, 'blocked');
    assert.equal(grant.budget().keySpentCents, 10);
    await assert.rejects(grant.sendAgent(input, undefined, 'blocked'));
    await assert.rejects(desktop.createAgentGrant(20));
    assert.equal(generated(), 1);
  } finally {
    await desktop.close();
  }
});
