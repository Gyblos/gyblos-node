import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { startDesktopPaypalAgent } from '@gyblos/desktop/paypal-agent-server';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('a disconnected client cannot cancel an already dispatched agent inference', async () => {
  const f = fixture();
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      f.calls.push('agent-generate');
      entered();
      await waiting;
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
  const endpoint = await startDesktopPaypalAgent(desktop, agentEngine.model);
  const request = httpRequest(`${endpoint.url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
    },
  });
  request.on('error', () => {});
  request.end(
    JSON.stringify({
      model: agentEngine.model,
      messages: [{ role: 'user', content: 'synthetic' }],
      max_tokens: 128,
    }),
  );
  let closed = false;
  try {
    await started;
    request.destroy();
    release();
    await endpoint.close();
    closed = true;
    assert.equal(desktop.status().spentCents, 10);
    assert.equal(desktop.status().phase, 'active');
    await desktop.finish();
    assert.deepEqual(f.calls, [
      'create',
      'authorize',
      'agent-generate',
      'capture:10',
    ]);
  } finally {
    release();
    request.destroy();
    if (!closed) await endpoint.close();
  }
});
