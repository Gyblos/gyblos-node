import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { createDesktopPaypalAgentAccess } from '@gyblos/desktop/paypal-agent-access';
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
    assert.equal(endpoint.budget().keySpentCents, 10);
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

void test('disconnect refuses an accepted slow request before it reaches inference', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      f.calls.push('agent-generate');
      throw new Error('must not run');
    },
  };
  const desktop = createDesktopPaypalSession(
    await createPaypalSession({ ...f, agentEngine }),
    async () => {},
  );
  await desktop.create();
  await desktop.approve();
  const endpoint = await startDesktopPaypalAgent(desktop, agentEngine.model);
  const access = createDesktopPaypalAgentAccess(
    desktop.status,
    async () => endpoint,
  );
  await access.connect();
  const body = JSON.stringify({
    model: agentEngine.model,
    messages: [{ role: 'user', content: 'synthetic' }],
    max_tokens: 128,
  });
  const request = httpRequest(`${endpoint.url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  });
  const response = new Promise<number | undefined>((resolve) => {
    request.on('error', () => resolve(undefined));
    request.on('response', (incoming) => {
      incoming.resume();
      incoming.on('end', () => resolve(incoming.statusCode));
    });
  });
  request.write(body.slice(0, 10));
  try {
    for (let attempt = 0; attempt < 500 && !endpoint.isBusy(); attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(endpoint.isBusy(), true);
    const disconnect = access.disconnect().then(
      () => true,
      () => false,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    request.end(body.slice(10));
    assert.notEqual(await response, 200);
    assert.equal(await disconnect, true);
    assert.equal(desktop.status().spentCents, 0);
    assert.deepEqual(f.calls, ['create', 'authorize']);
    await desktop.finish();
  } finally {
    request.destroy();
    await access.close();
  }
});

void test('disconnect revokes new agent requests while a started inference finishes', async () => {
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
  const access = createDesktopPaypalAgentAccess(
    desktop.status,
    async () => endpoint,
  );
  await access.connect();
  function request() {
    return fetch(`${endpoint.url}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${endpoint.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: agentEngine.model,
        messages: [{ role: 'user', content: 'synthetic' }],
        max_tokens: 128,
      }),
    });
  }
  const first = request();
  try {
    await started;
    let disconnected = false;
    const stopping = access.disconnect().then(() => {
      disconnected = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disconnected, false);
    const second = await request().catch(() => undefined);
    assert.notEqual(second?.status, 200);
    release();
    assert.equal((await first).status, 200);
    await stopping;
    assert.equal(desktop.status().spentCents, 10);
    assert.equal(endpoint.budget().keySpentCents, 10);
    await desktop.finish();
    assert.deepEqual(f.calls, [
      'create',
      'authorize',
      'agent-generate',
      'capture:10',
    ]);
  } finally {
    release();
    await access.close();
  }
});

void test('disconnect during the model preflight prevents a later inference', async () => {
  const f = fixture();
  let release = () => {};
  let entered = () => {};
  let checks = 0;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
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
    {
      checkAgentEngine: async () => {
        checks += 1;
        if (checks > 2) {
          entered();
          await waiting;
        }
      },
    },
  );
  await desktop.create();
  await desktop.approve();
  const endpoint = await startDesktopPaypalAgent(desktop, agentEngine.model);
  const access = createDesktopPaypalAgentAccess(
    desktop.status,
    async () => endpoint,
  );
  await access.connect();
  const request = fetch(`${endpoint.url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: agentEngine.model,
      messages: [{ role: 'user', content: 'synthetic' }],
      max_tokens: 128,
    }),
  });
  try {
    await started;
    const disconnect = access.disconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    assert.notEqual((await request).status, 200);
    await disconnect;
    assert.equal(desktop.status().spentCents, 0);
    assert.deepEqual(f.calls, ['create', 'authorize']);
    await desktop.finish();
  } finally {
    release();
    await access.close();
  }
});

void test('disconnect while recording dispatch prevents a later inference', async () => {
  const f = fixture();
  let release = () => {};
  let entered = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
      f.calls.push('agent-generate');
      throw new Error('must not run');
    },
  };
  const desktop = createDesktopPaypalSession(
    await createPaypalSession({ ...f, agentEngine }),
    async () => {},
  );
  await desktop.create();
  await desktop.approve();
  const write = f.journal.write;
  f.journal.write = async (value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      Reflect.get(value, 'phase') === 'executing'
    ) {
      entered();
      await waiting;
    }
    await write(value);
  };
  const endpoint = await startDesktopPaypalAgent(desktop, agentEngine.model);
  const access = createDesktopPaypalAgentAccess(
    desktop.status,
    async () => endpoint,
  );
  await access.connect();
  const request = fetch(`${endpoint.url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: agentEngine.model,
      messages: [{ role: 'user', content: 'synthetic' }],
      max_tokens: 128,
    }),
  });
  try {
    await started;
    const disconnect = access.disconnect();
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    assert.notEqual((await request).status, 200);
    await disconnect;
    assert.equal(desktop.status().spentCents, 0);
    assert.deepEqual(f.calls, ['create', 'authorize']);
    await desktop.finish();
  } finally {
    release();
    await access.close();
  }
});
