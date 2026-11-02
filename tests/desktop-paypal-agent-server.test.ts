import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
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

void test('a body started in an old session cannot execute after that session is settled', async () => {
  const f = fixture();
  const agentEngine = {
    model: 'synthetic-model',
    async generate() {
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
  const result = new Promise<number | undefined>((resolve, reject) => {
    request.on('error', reject);
    request.on('response', (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
  });
  try {
    request.write(body.slice(0, 10));
    for (let attempt = 0; attempt < 500 && !endpoint.isBusy(); attempt += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(endpoint.isBusy(), true);
    await desktop.finish();
    await desktop.create();
    await desktop.approve();
    request.end(body.slice(10));
    assert.notEqual(await result, 200);
    assert.equal(desktop.status().spentCents, 0);
    await desktop.finish();
  } finally {
    request.destroy();
    await endpoint.close();
  }
});

void test('retired access closes an incomplete request instead of delaying reconnection', async () => {
  const f = fixture();
  const desktop = createDesktopPaypalSession(
    await createPaypalSession(f),
    async () => {},
  );
  await desktop.create();
  await desktop.approve();
  const endpoint = await startDesktopPaypalAgent(desktop, 'synthetic-model');
  await desktop.finish();
  await desktop.create();
  await desktop.approve();
  const request = httpRequest(`${endpoint.url}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${endpoint.key}`,
      'content-type': 'application/json',
      'content-length': 1000,
    },
  });
  const result = new Promise<number | undefined>((resolve, reject) => {
    request.on('error', reject);
    request.on('response', (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
  });
  request.write('{');
  try {
    assert.equal(await result, 401);
    await Promise.race([
      endpoint.close(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('stale socket remained open')), 1000),
      ),
    ]);
    await desktop.finish();
  } finally {
    request.destroy();
  }
});

void test('shutdown closes a socket that never completes its HTTP headers', async () => {
  const f = fixture();
  const desktop = createDesktopPaypalSession(
    await createPaypalSession(f),
    async () => {},
  );
  await desktop.create();
  await desktop.approve();
  const endpoint = await startDesktopPaypalAgent(desktop, 'synthetic-model');
  const address = new URL(endpoint.url);
  const socket = createConnection({
    host: '127.0.0.1',
    port: Number(address.port),
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n');
  try {
    await Promise.race([
      endpoint.close(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('incomplete headers blocked shutdown')),
          1000,
        ),
      ),
    ]);
    await desktop.finish();
  } finally {
    socket.destroy();
  }
});

void test('shutdown waits for an already running inference before closing sockets', async () => {
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
  }).catch(() => undefined);
  await started;
  let closed = false;
  const stopping = endpoint.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([request, stopping]);
  assert.equal(desktop.status().phase, 'message_pending');
  await endpoint.acknowledgePending();
  await desktop.finish();
});
