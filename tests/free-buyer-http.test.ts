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
      headers: JSON_HEADERS,
      body,
      signal: controller.signal,
    }).catch(() => undefined),
  );
  try {
    for (let tick = 0; calls < controllers.length && tick < 100; tick++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, controllers.length);
    const refused = await fetch(server.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body,
    });
    assert.equal(refused.status, 429);
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

const JSON_HEADERS = { 'content-type': 'application/json' };
const SETTINGS = {
  selection: { modelId: 'synthetic', variant: null, quantization: null },
  maxTokens: 10,
};
const CHAT = JSON.stringify({
  model: 'synthetic',
  messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
});
const ANSWER = {
  text: 'answer',
  usage: { inputTokens: 4, outputTokens: 2 },
  finishReason: ENGINE_DONE_REASONS.STOP,
};

void test('free HTTP refuses browser-reachable requests (Origin, non-JSON content type) before execution', async () => {
  const api = await import('@gyblos/buyer/free-http');
  let calls = 0;
  const server = await api.startFreeBuyerHttp(
    async () => {
      calls++;
      return ANSWER;
    },
    SETTINGS,
    { port: 0 },
  );
  try {
    // fetch sends a string body as text/plain when no type is given.
    const browserReachable: Record<string, string>[] = [
      { ...JSON_HEADERS, origin: 'https://evil.example' },
      { ...JSON_HEADERS, origin: 'null' },
      { 'content-type': 'text/plain;charset=UTF-8' },
      { 'content-type': 'application/x-www-form-urlencoded' },
      {},
    ];
    for (const headers of browserReachable) {
      const response = await fetch(server.url, {
        method: 'POST',
        headers,
        body: CHAT,
      });
      assert.equal(response.status, 400, JSON.stringify(headers));
      await response.body?.cancel();
    }
    assert.equal(calls, 0);
    const accepted = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: CHAT,
    });
    assert.equal(accepted.status, 200);
    assert.equal(calls, 1);
  } finally {
    await server.close();
  }
});

void test('free HTTP refuses a declared oversize body at once without holding an admission slot', async () => {
  const api = await import('@gyblos/buyer/free-http');
  const { TRANSPORT_LIMITS } = await import('@gyblos/config');
  const { FREE_EXECUTION } = await import('@gyblos/protocol/constants');
  let calls = 0;
  const server = await api.startFreeBuyerHttp(
    async () => {
      calls++;
      return ANSWER;
    },
    SETTINGS,
    { port: 0 },
  );
  const stalled: ReturnType<typeof httpRequest>[] = [];
  try {
    const statuses = await Promise.all(
      Array.from(
        { length: TRANSPORT_LIMITS.maxConcurrent + 1 },
        () =>
          new Promise<number>((resolve, reject) => {
            const request = httpRequest(
              server.url,
              {
                method: 'POST',
                headers: {
                  ...JSON_HEADERS,
                  'content-length': String(FREE_EXECUTION.requestBytes + 1),
                },
              },
              (response) => {
                response.resume();
                resolve(response.statusCode!);
              },
            );
            request.on('error', reject);
            request.flushHeaders();
            stalled.push(request);
            setTimeout(() => reject(new Error('no early reply')), 2000);
          }),
      ),
    );
    for (const status of statuses) assert.equal(status, 413);
    const accepted = await fetch(server.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: CHAT,
    });
    assert.equal(accepted.status, 200);
    assert.equal(calls, 1);
  } finally {
    for (const request of stalled) request.destroy();
    await server.close();
  }
});

void test('free HTTP tells clients never to retry a possibly sent prompt; caller limits are 4xx', async () => {
  const api = await import('@gyblos/buyer/free-http');
  const { FreeClientError } =
    await import('@gyblos/transport-iroh/free-client');
  const { FreeExecutionError } =
    await import('@gyblos/protocol/free-execution');
  const { FREE_EXECUTION_CODES } = await import('@gyblos/protocol/constants');
  const cases: [unknown, number, string | null][] = [
    // Possibly sent: a standard OpenAI client would otherwise retry 5xx and resend the prompt.
    [new FreeClientError(FREE_EXECUTION_CODES.TIMEOUT, true), 503, 'false'],
    [new FreeClientError(FREE_EXECUTION_CODES.INTERNAL, true), 503, 'false'],
    [
      new FreeClientError(FREE_EXECUTION_CODES.DAILY_CAP, true, true),
      503,
      'false',
    ],
    [new FreeExecutionError(FREE_EXECUTION_CODES.BUSY, true), 503, 'false'],
    [new FreeExecutionError(FREE_EXECUTION_CODES.LIMIT, true), 400, 'false'],
    [new Error('unknown'), 500, 'false'],
    // Never sent: the request can be retried as is, or is the caller's fault.
    [new FreeExecutionError(FREE_EXECUTION_CODES.LIMIT), 400, 'false'],
    [new FreeClientError(FREE_EXECUTION_CODES.ENGINE, false), 503, null],
  ];
  for (const [error, status, retry] of cases) {
    const server = await api.startFreeBuyerHttp(
      async () => {
        throw error;
      },
      SETTINGS,
      { port: 0 },
    );
    try {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: CHAT,
      });
      const label = `${(error as Error).name}:${(error as Error).message}`;
      assert.equal(response.status, status, label);
      assert.equal(response.headers.get('x-should-retry'), retry, label);
      const value = await response.json();
      assert.equal(value.error.param, null, label);
    } finally {
      await server.close();
    }
  }
});

void test('free HTTP answers its own deadline with 504 and no-retry instead of a socket reset', async () => {
  const api = await import('@gyblos/buyer/free-http');
  const { FreeClientError } =
    await import('@gyblos/transport-iroh/free-client');
  const { FREE_EXECUTION_CODES } = await import('@gyblos/protocol/constants');
  const { FreeBuyerError } = await import('@gyblos/buyer/free-chat');
  const { FREE_BUYER_CODES } = await import('@gyblos/buyer/constants');
  let cancelled = 0;
  const server = await api.startFreeBuyerHttp(
    async (_input, signal) => {
      // Behaves as if the prompt was written before the deadline.
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      cancelled++;
      throw new FreeClientError(FREE_EXECUTION_CODES.CANCELLED, true);
    },
    SETTINGS,
    { port: 0, requestMs: 100 },
  );
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: CHAT,
    });
    assert.equal(response.status, 504);
    assert.equal(response.headers.get('x-should-retry'), 'false');
    assert.equal((await response.json()).error.code, 'FREE_BUYER_TIMEOUT');
    assert.equal(cancelled, 1);
    const unavailable = await api.startFreeBuyerHttp(
      async () => {
        throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      },
      SETTINGS,
      { port: 0 },
    );
    try {
      const retryable = await fetch(unavailable.url, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: CHAT,
      });
      assert.equal(retryable.status, 503);
      assert.equal(retryable.headers.get('x-should-retry'), null);
      await retryable.body?.cancel();
    } finally {
      await unavailable.close();
    }
  } finally {
    await server.close();
  }
});
