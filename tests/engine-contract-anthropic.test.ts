// Runs the shared Engine contract against engine-anthropic with a synthetic loopback Anthropic-compatible
// server, then the adapter's own rules: request shape and headers, the key's reach, billing and
// overload errors, hidden thinking, stop reasons, cumulative usage and the model check. No real
// provider, key or network beyond 127.0.0.1.
import assert from 'node:assert/strict';
import test from 'node:test';

import { ANTHROPIC_VERSION } from '@gyblos/engine-anthropic/constants';
import { createAnthropicEngine } from '@gyblos/engine-anthropic/engine';
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
  block,
  blockStop,
  COMPLETE,
  contractMessages,
  end,
  errorBody,
  event,
  FAKE_ANTHROPIC_MODEL,
  HEADERS,
  start,
  startFakeAnthropic,
  STOP,
  text,
  thinking,
  type Messages,
} from './support/fake-anthropic';
import { FAKE_SECRET } from './support/node-config-fixtures';

const CONTEXT = 200_000;

function engineAt(
  base: string,
  options: { generationTimeoutMs?: number } = {},
): Engine {
  return createAnthropicEngine(
    {
      base,
      model: FAKE_ANTHROPIC_MODEL,
      contextTokens: CONTEXT,
      apiKey: FAKE_SECRET,
    },
    fetch,
    options.generationTimeoutMs
      ? { generationTimeoutMs: options.generationTimeoutMs }
      : {},
  );
}

engineContract('engine-anthropic', {
  async start(behavior, options) {
    const server = await startFakeAnthropic(contractMessages(behavior));
    if (behavior === 'refused') await server.close();
    return {
      engine: engineAt(server.base, options),
      close: behavior === 'refused' ? async () => {} : server.close,
    };
  },
});

async function withServer(
  messages: Messages,
  use: (
    server: Awaited<ReturnType<typeof startFakeAnthropic>>,
  ) => Promise<void>,
  model?: Parameters<typeof startFakeAnthropic>[1],
) {
  const server = await startFakeAnthropic(messages, model);
  try {
    await use(server);
  } finally {
    await server.close();
  }
}
const stream =
  (body: string): Messages =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(body);
  };
const refused =
  (status: number, type: string): Messages =>
  (response) => {
    response.writeHead(status, HEADERS).end(errorBody(type));
  };
async function failure(engine: Engine) {
  return engine.generate({ prompt: 'synthetic', maxTokens: 8 }).then(
    () => assert.fail('generation should fail'),
    (error: unknown) => error,
  );
}
async function code(engine: Engine) {
  const error = await failure(engine);
  assert.ok(error instanceof EngineError, String(error));
  assertPrivate(error);
  assert.ok(!String(error.stack).includes(FAKE_SECRET));
  return error.code;
}

void test('engine-anthropic streams one user message with the key, version and max_tokens', () =>
  withServer(stream(COMPLETE), async (server) => {
    const result = await engineAt(server.base).generate({
      prompt: 'synthetic',
      maxTokens: 8,
    });
    assert.equal(result.text, CONTRACT_TEXT.join(''));
    assert.equal(result.finishReason, ENGINE_DONE_REASONS.STOP);
    assert.equal(result.usage.inputTokens, 3);
    assert.equal(result.usage.outputTokens, 2);
    const request = server.seen.find((seen) => seen.url === '/v1/messages')!;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-api-key'], FAKE_SECRET);
    assert.equal(request.headers['anthropic-version'], ANTHROPIC_VERSION);
    assert.equal(request.headers.authorization, undefined);
    assert.deepEqual(JSON.parse(request.body), {
      model: FAKE_ANTHROPIC_MODEL,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'synthetic' }],
      stream: true,
    });
  }));

void test('engine-anthropic maps max_tokens to length and stop_sequence to stop; tool use fails', async () => {
  for (const [reason, done] of [
    ['max_tokens', ENGINE_DONE_REASONS.LENGTH],
    ['stop_sequence', ENGINE_DONE_REASONS.STOP],
  ] as const)
    await withServer(
      stream(
        start() + block() + text('Hello') + blockStop() + end(reason) + STOP,
      ),
      async (server) => {
        const result = await engineAt(server.base).generate({
          prompt: 'x',
          maxTokens: 8,
        });
        assert.equal(result.finishReason, done, reason);
      },
    );
  await withServer(
    stream(start() + block() + text('Hello') + end('tool_use') + STOP),
    async (server) => {
      assert.equal(
        await code(engineAt(server.base)),
        ENGINE_ERROR_CODES.INTERRUPTED,
      );
    },
  );
});

void test('engine-anthropic never delivers thinking and refuses an answer that is only thinking', async () => {
  await withServer(
    stream(
      start() +
        block('thinking') +
        thinking('private thoughts') +
        blockStop() +
        block('text', 1) +
        text('Hello', 1) +
        blockStop(1) +
        end() +
        STOP,
    ),
    async (server) => {
      const fragments: string[] = [];
      const result = await engineAt(server.base).generate({
        prompt: 'x',
        maxTokens: 8,
        onText: async (value) => {
          fragments.push(value);
        },
      });
      assert.equal(result.text, 'Hello');
      assert.deepEqual(fragments, ['Hello']);
    },
  );
  await withServer(
    stream(
      start() +
        block('thinking') +
        thinking('private thoughts') +
        end('max_tokens', 8) +
        STOP,
    ),
    async (server) => {
      assert.equal(
        await code(engineAt(server.base)),
        ENGINE_ERROR_CODES.INVALID_RESPONSE,
      );
    },
  );
});

void test('engine-anthropic counts cached input and the final cumulative output', () =>
  withServer(
    stream(
      start(3, { cache_creation_input_tokens: 5, cache_read_input_tokens: 7 }) +
        block() +
        text('Hello') +
        event('message_delta', {
          delta: { stop_reason: null },
          usage: { output_tokens: 1 },
        }) +
        end('end_turn', 4) +
        STOP,
    ),
    async (server) => {
      const result = await engineAt(server.base).generate({
        prompt: 'x',
        maxTokens: 8,
      });
      assert.equal(result.usage.inputTokens, 15);
      assert.equal(result.usage.outputTokens, 4);
    },
  ));

void test('engine-anthropic: a stream without a final count is an invalid response, even after text', () =>
  withServer(
    stream(
      start() +
        block() +
        text('Hello') +
        event('message_delta', { delta: { stop_reason: 'end_turn' } }) +
        STOP,
    ),
    async (server) => {
      assert.equal(
        await code(engineAt(server.base)),
        ENGINE_ERROR_CODES.INVALID_RESPONSE,
      );
    },
  ));

void test('engine-anthropic ignores unknown events and returns once finished and counted', () =>
  withServer(
    (response) => {
      response
        .writeHead(200, { 'content-type': 'text/event-stream' })
        .write(
          start() +
            event('future_event', { anything: true }) +
            block() +
            text('Hello') +
            end(),
        );
    },
    async (server) => {
      const result = await engineAt(server.base, {
        generationTimeoutMs: 5_000,
      }).generate({ prompt: 'x', maxTokens: 8 });
      assert.equal(result.text, 'Hello');
    },
  ));

void test('engine-anthropic: billing is quota exhaustion, overload and rate limits are classified', async () => {
  for (const [status, type, expected] of [
    [400, 'billing_error', ENGINE_ERROR_CODES.QUOTA_EXHAUSTED],
    [402, 'billing_error', ENGINE_ERROR_CODES.QUOTA_EXHAUSTED],
    [429, 'rate_limit_error', ENGINE_ERROR_CODES.RATE_LIMITED],
    [529, 'overloaded_error', ENGINE_ERROR_CODES.UNAVAILABLE],
    [403, 'permission_error', ENGINE_ERROR_CODES.AUTH],
  ] as const)
    await withServer(refused(status, type), async (server) => {
      assert.equal(await code(engineAt(server.base)), expected, type);
    });
});

void test('engine-anthropic follows no redirect, so the key never reaches another location', () =>
  withServer(
    (response) => {
      response.writeHead(307, { location: '/elsewhere' }).end();
    },
    async (server) => {
      assert.equal(
        await code(engineAt(server.base)),
        ENGINE_ERROR_CODES.UNAVAILABLE,
      );
      assert.ok(server.seen.every((seen) => !seen.url.includes('elsewhere')));
    },
  ));

void test('engine-anthropic describes its model by id with the key, and reports a missing one', async () => {
  await withServer(stream(COMPLETE), async (server) => {
    const engine = engineAt(server.base);
    assert.deepEqual(await engine.describe(), {
      name: FAKE_ANTHROPIC_MODEL,
      contextTokens: CONTEXT,
    });
    const request = server.seen.at(-1)!;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/v1/models/${FAKE_ANTHROPIC_MODEL}`);
    assert.equal(request.headers['x-api-key'], FAKE_SECRET);
    assert.deepEqual(engine.capabilities(), {
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: false,
      modelIdentity: 'name-only',
    });
  });
  await withServer(
    stream(COMPLETE),
    async (server) => {
      await assert.rejects(engineAt(server.base).describe(), {
        code: ENGINE_ERROR_CODES.UNAVAILABLE,
      });
    },
    refused(404, 'not_found_error'),
  );
  await withServer(
    stream(COMPLETE),
    async (server) => {
      await assert.rejects(engineAt(server.base).describe(), {
        code: ENGINE_ERROR_CODES.AUTH,
      });
    },
    refused(401, 'authentication_error'),
  );
});

void test('engine-anthropic refuses output limits outside the request bounds before any call', () =>
  withServer(stream(COMPLETE), async (server) => {
    const engine = engineAt(server.base);
    for (const maxTokens of [0, 1.5, 1_000_000])
      await assert.rejects(engine.generate({ prompt: 'x', maxTokens }));
    assert.equal(server.seen.length, 0);
  }));

void test('engine-anthropic: the usual low-credit 400 is quota exhaustion, other 400s are not', async () => {
  const invalid =
    (message: string): Messages =>
    (response) => {
      response.writeHead(400, HEADERS).end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message },
        }),
      );
    };
  for (const [message, expected] of [
    [
      'Your credit balance is too low to access the Anthropic API. UPSTREAM-SECRET-MARKER',
      ENGINE_ERROR_CODES.QUOTA_EXHAUSTED,
    ],
    // Matched only near the start of the message.
    [`${'x'.repeat(512)} credit balance`, ENGINE_ERROR_CODES.UNAVAILABLE],
    ['UPSTREAM-SECRET-MARKER', ENGINE_ERROR_CODES.UNAVAILABLE],
  ] as const)
    await withServer(invalid(message), async (server) => {
      assert.equal(await code(engineAt(server.base)), expected);
    });
});

void test('engine-anthropic: a model window smaller than configured ends as a length stop', () =>
  withServer(
    stream(
      start() +
        block() +
        text('Hello') +
        end('model_context_window_exceeded') +
        STOP,
    ),
    async (server) => {
      const result = await engineAt(server.base).generate({
        prompt: 'x',
        maxTokens: 8,
      });
      assert.equal(result.finishReason, ENGINE_DONE_REASONS.LENGTH);
    },
  ));
