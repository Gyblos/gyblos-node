// Runs the shared Engine contract against engine-openai with a synthetic loopback OpenAI-compatible
// server, then the adapter's own rules: request shape, the API key's reach, quota and missing usage,
// hidden reasoning, redirects and the model listing. No real provider, key or network beyond 127.0.0.1.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createOpenAiEngine } from '@gyblos/engine-openai/engine';
import {
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { EngineError, type Engine } from '@gyblos/protocol/engine';

import {
  assertPrivate,
  CONTRACT_TEXT,
  engineContract,
} from './support/engine-contract';
import {
  chunk,
  COMPLETE,
  contractCompletion,
  DONE,
  FAKE_OPENAI_MODEL,
  finish,
  HEADERS,
  listing,
  sse,
  startFakeOpenAi,
  usage,
  type Completion,
} from './support/fake-openai';
import { FAKE_SECRET } from './support/node-config-fixtures';

const CONTEXT = 32_768;

function engineAt(
  base: string,
  options: { apiKey?: string; generationTimeoutMs?: number } = {},
): Engine {
  return createOpenAiEngine(
    {
      base,
      model: FAKE_OPENAI_MODEL,
      contextTokens: CONTEXT,
      recountable: false,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    },
    fetch,
    options.generationTimeoutMs
      ? { generationTimeoutMs: options.generationTimeoutMs }
      : {},
  );
}

engineContract('engine-openai', {
  async start(behavior, options) {
    const server = await startFakeOpenAi(contractCompletion(behavior));
    if (behavior === 'refused') await server.close();
    return {
      engine: engineAt(server.base, options),
      close: behavior === 'refused' ? async () => {} : server.close,
    };
  },
});

async function withServer(
  completion: Completion,
  use: (server: Awaited<ReturnType<typeof startFakeOpenAi>>) => Promise<void>,
  models?: Parameters<typeof startFakeOpenAi>[1],
) {
  const server = await startFakeOpenAi(completion, models);
  try {
    await use(server);
  } finally {
    await server.close();
  }
}
const stream =
  (body: string): Completion =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(body);
  };
async function failure(engine: Engine) {
  return engine.generate({ prompt: 'synthetic', maxTokens: 8 }).then(
    () => assert.fail('generation should fail'),
    (error: unknown) => error,
  );
}

void test('engine-openai streams one user message with the upstream model, max_tokens and usage', () =>
  withServer(stream(COMPLETE), async (server) => {
    const result = await engineAt(server.base, {
      apiKey: FAKE_SECRET,
    }).generate({ prompt: 'synthetic', maxTokens: 8 });
    assert.equal(result.text, CONTRACT_TEXT.join(''));
    assert.equal(result.finishReason, ENGINE_DONE_REASONS.STOP);
    assert.equal(result.usage.inputTokens, 3);
    assert.equal(result.usage.outputTokens, 2);
    const request = server.seen.find((seen) =>
      seen.url.endsWith('/chat/completions'),
    )!;
    assert.equal(request.method, 'POST');
    assert.equal(request.authorization, `Bearer ${FAKE_SECRET}`);
    assert.deepEqual(JSON.parse(request.body), {
      model: FAKE_OPENAI_MODEL,
      messages: [{ role: 'user', content: 'synthetic' }],
      max_tokens: 8,
      stream: true,
      stream_options: { include_usage: true },
    });
  }));

void test('engine-openai sends no authorization without a key', () =>
  withServer(stream(COMPLETE), async (server) => {
    await engineAt(server.base).generate({ prompt: 'x', maxTokens: 8 });
    assert.ok(server.seen.every((seen) => seen.authorization === undefined));
  }));

void test('engine-openai reports a length stop', () =>
  withServer(
    stream(chunk('Hello') + finish('length') + usage(3, 8) + DONE),
    async (server) => {
      const result = await engineAt(server.base).generate({
        prompt: 'x',
        maxTokens: 8,
      });
      assert.equal(result.finishReason, ENGINE_DONE_REASONS.LENGTH);
    },
  ));

void test('engine-openai never delivers hidden reasoning text', () =>
  withServer(
    stream(
      chunk('', { reasoning_content: 'private thoughts' }) +
        COMPLETE.replace(DONE, '') +
        DONE,
    ),
    async (server) => {
      const fragments: string[] = [];
      const result = await engineAt(server.base).generate({
        prompt: 'x',
        maxTokens: 8,
        onText: async (text) => {
          fragments.push(text);
        },
      });
      assert.equal(result.text, CONTRACT_TEXT.join(''));
      assert.equal(fragments.join(''), CONTRACT_TEXT.join(''));
    },
  ));

void test('engine-openai: a completion without usage is an invalid response, even after text', () =>
  withServer(
    stream(CONTRACT_TEXT.map((text) => chunk(text)).join('') + finish() + DONE),
    async (server) => {
      const error = await failure(engineAt(server.base));
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, ENGINE_ERROR_CODES.INVALID_RESPONSE);
    },
  ));

void test('engine-openai: a 429 for insufficient quota is quota exhaustion, never echoing the body', () =>
  withServer(
    (response) => {
      response.writeHead(429, HEADERS).end(
        JSON.stringify({
          error: {
            message: 'UPSTREAM-SECRET-MARKER',
            type: 'insufficient_quota',
            code: 'insufficient_quota',
          },
        }),
      );
    },
    async (server) => {
      const error = await failure(
        engineAt(server.base, { apiKey: FAKE_SECRET }),
      );
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, ENGINE_ERROR_CODES.QUOTA_EXHAUSTED);
      assertPrivate(error);
      assert.ok(!String(error.stack).includes(FAKE_SECRET));
    },
  ));

void test('engine-openai follows no redirect, so the key never reaches another location', () =>
  withServer(
    (response) => {
      response.writeHead(307, { location: '/elsewhere' }).end();
    },
    async (server) => {
      const error = await failure(
        engineAt(server.base, { apiKey: FAKE_SECRET }),
      );
      assert.ok(error instanceof EngineError);
      assert.equal(error.code, ENGINE_ERROR_CODES.UNAVAILABLE);
      assert.ok(server.seen.every((seen) => !seen.url.includes('elsewhere')));
    },
  ));

void test('engine-openai describes the listed upstream model with the configured context', () =>
  withServer(stream(COMPLETE), async (server) => {
    const engine = engineAt(server.base, { apiKey: FAKE_SECRET });
    assert.deepEqual(await engine.describe(), {
      name: FAKE_OPENAI_MODEL,
      contextTokens: CONTEXT,
    });
    const request = server.seen.at(-1)!;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/v1/models');
    assert.equal(request.authorization, `Bearer ${FAKE_SECRET}`);
    assert.deepEqual(engine.capabilities(), {
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: false,
      modelIdentity: 'name-only',
    });
  }));

void test('engine-openai: an unlisted model is unavailable and a refused key is an auth failure', async () => {
  await withServer(
    stream(COMPLETE),
    async (server) => {
      await assert.rejects(engineAt(server.base).describe(), {
        code: ENGINE_ERROR_CODES.UNAVAILABLE,
      });
    },
    listing(['another/model']),
  );
  await withServer(
    stream(COMPLETE),
    async (server) => {
      await assert.rejects(engineAt(server.base).describe(), {
        code: ENGINE_ERROR_CODES.AUTH,
      });
    },
    (response) => {
      response.writeHead(401, HEADERS).end(sse('UPSTREAM-SECRET-MARKER'));
    },
  );
});

void test('engine-openai refuses output limits outside the request bounds before any call', () =>
  withServer(stream(COMPLETE), async (server) => {
    const engine = engineAt(server.base);
    for (const maxTokens of [0, 1.5, 1_000_000])
      await assert.rejects(engine.generate({ prompt: 'x', maxTokens }));
    assert.equal(server.seen.length, 0);
  }));
