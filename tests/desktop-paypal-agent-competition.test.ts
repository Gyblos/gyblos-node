import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalAgentGateway } from '@gyblos/node/paypal-agent-gateway';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('a temporarily busy shared session tells the agent to retry without dispatch', async () => {
  const f = fixture();
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.engine.generate = async () => {
    f.calls.push('generate');
    entered();
    await waiting;
    return { text: 'synthetic', usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const model = 'synthetic-model';
  const agentEngine = {
    model,
    async generate() {
      f.calls.push('agent-generate');
      return {
        id: 'synthetic',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'answer' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const desktop = createDesktopPaypalSession(
    await createPaypalSession({ ...f, agentEngine }),
    async () => {},
  );
  await desktop.create();
  await desktop.approve();
  const origin = 'http://127.0.0.1:12345';
  const gateway = createPaypalAgentGateway({
    origin,
    key: 'test-key',
    model,
    service: desktop,
  });
  function post() {
    return new Request(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:12345',
        authorization: 'Bearer test-key',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'synthetic' }],
        max_tokens: 16,
      }),
    });
  }
  const chat = desktop.send('synthetic chat');
  try {
    await started;
    const busy = await gateway.handle(post());
    assert.equal(busy.status, 409);
    assert.equal(busy.headers.get('x-should-retry'), 'true');
    assert.equal((await busy.json()).error.code, 'PAYPAL_BUSY');
  } finally {
    release();
  }
  const answer = await chat;
  await desktop.acknowledge(answer.messageId);
  assert.equal((await gateway.handle(post())).status, 200);
  await desktop.finish();
  assert.deepEqual(f.calls, [
    'create',
    'authorize',
    'generate',
    'agent-generate',
    'capture:20',
  ]);
});
