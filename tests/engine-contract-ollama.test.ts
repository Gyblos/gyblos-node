// Runs the shared Engine contract against engine-ollama with a synthetic loopback Ollama server.
// No model, tokenizer or network beyond 127.0.0.1 is used.
import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import test from 'node:test';

import { ROUTES } from '@gyblos/config';
import type { OllamaOptions } from '@gyblos/engine-ollama';
import { MODEL, MODEL_LIMITS } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { renderConversation } from '@gyblos/engine-ollama/model';
import {
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
  type EngineErrorCode,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';

import {
  assertPrivate,
  CONTRACT_TEXT,
  engineContract,
  UPSTREAM_MARKER,
  type EngineBehavior,
} from './support/engine-contract';

const HEADERS = { 'x-upstream': UPSTREAM_MARKER };
const STATUSES: Partial<Record<EngineBehavior, number>> = {
  'status-401': 401,
  'status-402': 402,
  'status-429': 429,
  'status-500': 500,
};

function frame(text: string, done = false) {
  return (
    JSON.stringify({
      model: MODEL.name,
      response: text,
      done,
      ...(done
        ? {
            done_reason: ENGINE_DONE_REASONS.STOP,
            prompt_eval_count: 1,
            eval_count: 2,
            total_duration: 3,
            load_duration: 0,
            prompt_eval_duration: 1,
            eval_duration: 2,
          }
        : {}),
    }) + '\n'
  );
}
const complete = frame(CONTRACT_TEXT[0]) + frame(CONTRACT_TEXT[1], true);
const upstreamError = JSON.stringify({ error: UPSTREAM_MARKER }) + '\n';

function generation(behavior: EngineBehavior, response: ServerResponse) {
  const status = STATUSES[behavior];
  if (status !== undefined) {
    response.writeHead(status, HEADERS).end(upstreamError);
    return;
  }
  response.writeHead(200, {
    ...HEADERS,
    'content-type': 'application/x-ndjson',
  });
  if (behavior === 'slow') return;
  if (behavior === 'error-before-text') response.end(upstreamError);
  else if (behavior === 'error-after-text')
    response.end(frame(CONTRACT_TEXT[0]) + upstreamError);
  else if (behavior === 'truncated-after-text')
    response.end(frame(CONTRACT_TEXT[0]));
  else if (behavior === 'malformed-before-text')
    response.end(`{${UPSTREAM_MARKER}\n`);
  else if (behavior === 'oversize')
    response.end(
      frame(UPSTREAM_MARKER.repeat(MODEL_LIMITS.maxOutputCharacters)),
    );
  else response.end(complete);
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const servedTags: Handler = (_request, response) => {
  response
    .writeHead(200, HEADERS)
    .end(
      JSON.stringify({ models: [{ name: MODEL.name, digest: MODEL.digest }] }),
    );
};

// Serves synthetic Ollama routes on loopback; close() destroys open sockets so stalls never leak.
async function serve(tags: Handler, generate: Handler, options: OllamaOptions) {
  const sockets = new Set<Socket>();
  const calls = { tags: 0, generate: 0 };
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === ROUTES.ollamaTags) {
      calls.tags++;
      tags(request, response);
      return;
    }
    calls.generate++;
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => bodies.push(body));
    generate(request, response);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    calls,
    bodies,
    engine: createOllamaEngine(`http://127.0.0.1:${port}/`, fetch, options),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

engineContract('engine-ollama', {
  async start(behavior, options) {
    const tags: Handler =
      behavior === 'model-missing'
        ? (_request, response) => {
            response.writeHead(200, HEADERS).end(
              JSON.stringify({
                models: [{ name: UPSTREAM_MARKER, digest: MODEL.digest }],
              }),
            );
          }
        : servedTags;
    const started = await serve(
      tags,
      (_request, response) => generation(behavior, response),
      options,
    );
    if (behavior === 'refused') await started.close();
    return {
      engine: started.engine,
      close: behavior === 'refused' ? async () => {} : started.close,
    };
  },
});

// Ollama-specific paths beyond the shared contract: its model inventory check and socket failures.
const SHORT = { generationTimeoutMs: 200, modelCheckTimeoutMs: 200 };
async function failure(
  tags: Handler,
  generate: Handler,
  expected: EngineErrorCode,
) {
  const started = await serve(tags, generate, SHORT);
  try {
    const fragments: string[] = [];
    const error = await started.engine
      .generate({
        prompt: 'synthetic',
        maxTokens: 8,
        onText: async (text) => {
          fragments.push(text);
        },
      })
      .then(
        () => assert.fail('generation should fail'),
        (rejected: unknown) => rejected,
      );
    assert.ok(error instanceof EngineError, String(error));
    assert.equal(error.code, expected);
    assertPrivate(error);
    return { fragments, calls: started.calls };
  } finally {
    await started.close();
  }
}
const generated: Handler = (_request, response) => {
  response.writeHead(200, HEADERS).end(complete);
};

void test('engine-ollama: a failing or malformed model inventory is unavailable without leaking', async () => {
  for (const tags of [
    ((_request, response) => {
      response.writeHead(429, HEADERS).end(upstreamError);
    }) satisfies Handler,
    ((_request, response) => {
      response.writeHead(200, HEADERS).end(`{${UPSTREAM_MARKER}`);
    }) satisfies Handler,
  ]) {
    const { calls } = await failure(
      tags,
      generated,
      ENGINE_ERROR_CODES.UNAVAILABLE,
    );
    assert.equal(calls.generate, 0);
  }
});
void test('engine-ollama: a stalled model inventory times out on its own deadline', async () => {
  await failure(() => {}, generated, ENGINE_ERROR_CODES.TIMEOUT);
});
void test('engine-ollama: a reset generation is unavailable before text and interrupted after', async () => {
  await failure(
    servedTags,
    (request) => {
      request.socket.destroy();
    },
    ENGINE_ERROR_CODES.UNAVAILABLE,
  );
  const after = await failure(
    servedTags,
    (request, response) => {
      response.writeHead(200, HEADERS);
      response.write(frame(CONTRACT_TEXT[0]), () => {
        setTimeout(() => request.socket.destroy(), 20);
      });
    },
    ENGINE_ERROR_CODES.INTERRUPTED,
  );
  assert.deepEqual(after.fragments, [CONTRACT_TEXT[0]]);
});
void test('engine-ollama: output beyond its bound after text is an invalid response', async () => {
  const { fragments } = await failure(
    servedTags,
    (_request, response) => {
      response
        .writeHead(200, HEADERS)
        .end(
          frame(CONTRACT_TEXT[0]) +
            frame('x'.repeat(MODEL_LIMITS.maxOutputCharacters)),
        );
    },
    ENGINE_ERROR_CODES.INVALID_RESPONSE,
  );
  assert.deepEqual(fragments, [CONTRACT_TEXT[0]]);
});
void test('engine-ollama: a caller abort during the inventory check rejects with its reason', async () => {
  const started = await serve(() => {}, generated, SHORT);
  try {
    const controller = new AbortController();
    const reason = new Error('synthetic caller abort');
    const generation = started.engine.generate({
      prompt: 'synthetic',
      maxTokens: 8,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(reason), 20);
    await assert.rejects(generation, (error: unknown) => error === reason);
  } finally {
    await started.close();
  }
});
void test('engine-ollama: a conversation is rendered with the template and the offer’s context sets num_ctx', async () => {
  const started = await serve(servedTags, generated, {
    ...SHORT,
    contextTokens: 16384,
  });
  try {
    const messages = [
      { role: 'system' as const, content: 'Answer briefly.' },
      { role: 'user' as const, content: 'My name is Ana.' },
      { role: 'assistant' as const, content: 'Hello, Ana.' },
      { role: 'user' as const, content: 'What is my name?' },
    ];
    await started.engine.generate({ messages, maxTokens: 1000 });
    assert.equal((await started.engine.describe()).contextTokens, 16384);
    const body = JSON.parse(started.bodies[0]!) as {
      prompt: string;
      options: { num_ctx: number; num_predict: number };
    };
    assert.equal(body.prompt, renderConversation(messages));
    assert.equal(body.options.num_ctx, 16384);
    assert.equal(body.options.num_predict, 1000);
  } finally {
    await started.close();
  }
  assert.throws(() =>
    createOllamaEngine('http://127.0.0.1:11434/', fetch, {
      contextTokens: 65536,
    }),
  );
});

void test('engine-ollama: an unsupported prompt stays a programming error before any request', async () => {
  const started = await serve(servedTags, generated, SHORT);
  try {
    await assert.rejects(
      started.engine.generate({ prompt: 'x<think>y', maxTokens: 8 }),
      (error: unknown) =>
        error instanceof Error && !(error instanceof EngineError),
    );
    assert.deepEqual(started.calls, { tags: 0, generate: 0 });
  } finally {
    await started.close();
  }
});
