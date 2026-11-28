// Exercises the local compatibility endpoint with a synthetic executor and no inference/payment services.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
} from '@gyblos/protocol/constants';

const JSON_HEADERS = { 'content-type': 'application/json' };

void test('free HTTP returns a complete completion and refuses unsupported input before execution', async () => {
  const api = await import('@gyblos/buyer/free-http');
  let calls = 0;
  const server = await api.startFreeBuyerHttp(
    async () => {
      calls++;
      return {
        text: 'answer',
        usage: { inputTokens: 4, outputTokens: 2 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      };
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
    },
    { port: 0 },
  );
  try {
    const body = {
      model: 'synthetic',
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
    };
    const response = await fetch(server.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.choices[0].message.content, 'answer');
    assert.deepEqual(value.usage, {
      prompt_tokens: 4,
      completion_tokens: 2,
      total_tokens: 6,
    });
    const rejected = await fetch(server.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ...body, stream: true }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(calls, 1);
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        server.url,
        { method: 'POST', headers: { host: 'evil.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
    assert.notEqual(wrongHost, 200);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

void test('free HTTP cancellation reaches execution and admission rejects excess active requests', async () => {
  const api = await import('@gyblos/buyer/free-http');
  const { TRANSPORT_LIMITS } = await import('@gyblos/config');
  const { FreeClientError } =
    await import('@gyblos/transport-iroh/free-client');
  const { FREE_EXECUTION_CODES } = await import('@gyblos/protocol/constants');
  let calls = 0;
  let cancellations = 0;
  const { BUYER_HTTP_DIAGNOSTICS } = await import('@gyblos/buyer/constants');
  let notifyDisconnect = () => {};
  const disconnected = new Promise<void>((resolve) => {
    notifyDisconnect = resolve;
  });
  const server = await api.startFreeBuyerHttp(
    async (_input, signal) => {
      calls++;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancellations++;
            resolve();
          },
          { once: true },
        ),
      );
      throw new FreeClientError(FREE_EXECUTION_CODES.CANCELLED, true);
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
    },
    {
      port: 0,
      diagnostics: (record) => {
        if (record.code === BUYER_HTTP_DIAGNOSTICS.codes.CLOSED)
          notifyDisconnect();
      },
    },
  );
  const controllers = Array.from(
    { length: TRANSPORT_LIMITS.maxConcurrent },
    () => new AbortController(),
  );
  const body = JSON.stringify({
    model: 'synthetic',
    messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
  });
  const pending = controllers.map((controller) =>
    fetch(server.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
      signal: controller.signal,
    }).catch(() => undefined),
  );
  try {
    for (let tick = 0; calls < controllers.length && tick < 100; tick++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, controllers.length);
    const waiters = Array.from({ length: 2 }, () => new AbortController());
    const queued = waiters.map((controller) =>
      fetch(server.url, {
        method: 'POST',
        headers: JSON_HEADERS,
        body,
        signal: controller.signal,
      }).catch(() => undefined),
    );
    const refused = await fetch(server.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
    });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '1');
    assert.equal(calls, controllers.length);
    waiters[0]!.abort();
    await disconnected;
    controllers[0]!.abort();
    for (let tick = 0; calls < controllers.length + 1 && tick < 100; tick++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, controllers.length + 1);
    waiters[1]!.abort();
    for (const controller of controllers) controller.abort();
    await Promise.all([...pending, ...queued]);
    for (
      let tick = 0;
      cancellations < controllers.length + 1 && tick < 100;
      tick++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cancellations, controllers.length + 1);
  } finally {
    for (const controller of controllers) controller.abort();
    await server.close();
  }
});

void test('an authenticated Responses call expiring in the admission queue is a retryable unsent 504', async (t) => {
  const { startFreeBuyerHttp } = await import('@gyblos/buyer/free-http');
  const { FREE_BUYER, PAID_BUYER } = await import('@gyblos/buyer/constants');
  const { BUYER_API } = await import('@gyblos/protocol/buyer-api');
  const { batchDeferred } = await import('./support/batch-deferred');
  const started = batchDeferred<void>();
  const finish = batchDeferred<void>();
  let calls = 0;
  const token = 'T'.repeat(PAID_BUYER.tokenChars);
  const host = await startFreeBuyerHttp(
    async () => {
      calls++;
      started.resolve();
      await finish.promise;
      return {
        text: 'done',
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: ENGINE_DONE_REASONS.STOP,
      };
    },
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 10,
      parallel: 1,
    },
    { port: 0, requestMs: 250, token },
  );
  t.after(async () => {
    finish.resolve();
    await host.close();
  });
  const send = () =>
    fetch(new URL('/v1/responses', host.url), {
      method: 'POST',
      headers: { ...JSON_HEADERS, authorization: 'Bearer ' + token },
      body: JSON.stringify({
        model: 'synthetic',
        input: 'hello',
        max_output_tokens: 5,
      }),
    });
  const running = send();
  await started.promise;
  const queued = await send();
  assert.equal(queued.status, 504);
  assert.equal((await queued.json()).error[BUYER_API.NEVER_SENT_FIELD], true);
  assert.equal(queued.headers.get(FREE_BUYER.noRetryHeader), null);
  assert.equal(calls, 1);
  const active = await running;
  assert.equal(active.status, 400);
});
