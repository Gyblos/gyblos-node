// Exercises the local compatibility endpoint with a synthetic executor and no inference/payment services.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
} from '@gyblos/protocol/constants';

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
    { port: 0 },
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
      body,
      signal: controller.signal,
    }).catch(() => undefined),
  );
  try {
    for (let tick = 0; calls < controllers.length && tick < 100; tick++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, controllers.length);
    const refused = await fetch(server.url, { method: 'POST', body });
    assert.equal(refused.status, 503);
    assert.equal(calls, controllers.length);
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    for (let tick = 0; cancellations < controllers.length && tick < 100; tick++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cancellations, controllers.length);
  } finally {
    for (const controller of controllers) controller.abort();
    await server.close();
  }
});
