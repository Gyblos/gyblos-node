import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startDesktopPaypalAgent } from '@gyblos/desktop/paypal-agent-server';
import { createDesktopPaypalSession } from '@gyblos/desktop/paypal-session';
import { createPaypalSession } from '@gyblos/node/paypal-session';

import { fixture } from './support/paypal-session-fixture';

void test('a local agent connects through a key and shares the sandbox authorization', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      f.calls.push('agent-generate');
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
  const session = await createPaypalSession({ ...f, agentEngine });
  const desktop = createDesktopPaypalSession(session, async () => {});
  await desktop.create();
  await desktop.approve();
  const agent = await startDesktopPaypalAgent(desktop, agentEngine.model);
  try {
    const endpoint = `${agent.url}/chat/completions`;
    const request = {
      model: agentEngine.model,
      messages: [{ role: 'user', content: 'synthetic request' }],
      max_tokens: 128,
    };
    const headers = {
      authorization: `Bearer ${agent.key}`,
      'content-type': 'application/json',
    };
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { ...headers, authorization: 'Bearer wrong' },
          body: JSON.stringify(request),
        })
      ).status,
      401,
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 200);
    assert.equal(agent.hasPending(), true);
    await assert.rejects(desktop.finish());
    await agent.acknowledgePending();
    assert.equal((await desktop.finish()).spentCents, 10);
    assert.deepEqual(f.calls, [
      'create',
      'authorize',
      'agent-generate',
      'capture:10',
    ]);
  } finally {
    await agent.close();
  }
});

void test('an agent key cannot spend a later sandbox authorization', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
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
  const first = await startDesktopPaypalAgent(desktop, agentEngine.model);
  const request = {
    model: agentEngine.model,
    messages: [{ role: 'user', content: 'synthetic' }],
    max_tokens: 128,
  };
  const call = (endpoint: typeof first) =>
    fetch(`${endpoint.url}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
  try {
    assert.equal((await call(first)).status, 200);
    await first.acknowledgePending();
    const capture = f.payment.capture;
    let enteredCapture = () => {};
    let releaseCapture = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredCapture = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    f.payment.capture = async (...args) => {
      enteredCapture();
      await waiting;
      return capture(...args);
    };
    const settling = desktop.finish();
    await entered;
    try {
      assert.notEqual((await call(first)).status, 200);
    } finally {
      releaseCapture();
    }
    await settling;
    const retiredCatalog = await fetch(`${first.url}/models`, {
      headers: { authorization: `Bearer ${first.key}` },
    });
    assert.equal(retiredCatalog.status, 401);
    await desktop.create();
    await desktop.approve();
    assert.notEqual((await call(first)).status, 200);
    assert.equal(desktop.status().spentCents, 0);
    const second = await startDesktopPaypalAgent(desktop, agentEngine.model);
    try {
      assert.notEqual(second.key, first.key);
      assert.equal((await call(second)).status, 200);
      await second.acknowledgePending();
      await desktop.finish();
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
  }
});
