// A seller whose engine ran out of time is named as too slow, in each chat format the local endpoint
// speaks, so an agent's user knows to send the request again (another seller) or make it smaller.
// Synthetic executors and loopback HTTP only; no seller, network or payment.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_CHAT_DETAILS } from '@gyblos/buyer/constants';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import {
  FREE_EXECUTION_CODES,
  FREE_EXECUTION_STOP_REASONS,
} from '@gyblos/protocol/constants';
import type { FreeExecutionStop } from '@gyblos/protocol/free-execution';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

const SELECTION = { modelId: 'synthetic', variant: null, quantization: null };
const ROUTES = {
  openai: '/v1/chat/completions',
  anthropic: '/v1/messages',
  responses: '/v1/responses',
} as const;
type Api = keyof typeof ROUTES;
const BODIES: Record<Api, (stream: boolean) => unknown> = {
  openai: (stream) => ({
    model: 'synthetic',
    messages: [{ role: 'user', content: 'a long agent prompt' }],
    stream,
  }),
  anthropic: (stream) => ({
    model: 'synthetic',
    max_tokens: 4,
    messages: [{ role: 'user', content: 'a long agent prompt' }],
    stream,
  }),
  responses: (stream) => ({
    model: 'synthetic',
    input: 'a long agent prompt',
    stream,
  }),
};

const timedOut = (stop: FreeExecutionStop) =>
  new FreeClientError(
    FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    true,
    true,
    stop,
  );

async function call(api: Api, stream: boolean, delivered: boolean) {
  const fail = async (onDelta: (text: string) => Promise<void>) => {
    if (delivered) await onDelta('partial');
    throw timedOut({
      reason: FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT,
      ...(delivered ? { delivered: { outputTokens: 1 } } : {}),
    });
  };
  const server = await startFreeBuyerHttp(
    () => fail(async () => {}),
    { selection: SELECTION, maxTokens: 10 },
    { port: 0, stream: (_input, _signal, onDelta) => fail(onDelta) },
  );
  try {
    const response = await fetch(new URL(ROUTES[api], server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODIES[api](stream)),
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await server.close();
  }
}

// The error object of a JSON answer, or of the last event of a stream.
function lastError(text: string) {
  const blocks = text.trim().split('\n\n');
  const data = (block: string) =>
    JSON.parse(
      block
        .split('\n')
        .find((line) => line.startsWith('data: '))!
        .slice('data: '.length),
    );
  const body = text.trimStart().startsWith('{')
    ? JSON.parse(text)
    : data(blocks.at(-1)!);
  return body.response?.error ?? body.error;
}

for (const api of Object.keys(ROUTES) as Api[]) {
  void test(`${api}: a seller too slow to read the request says so before any output`, async () => {
    for (const stream of [false, true]) {
      const { status, text } = await call(api, stream, false);
      assert.ok(status >= 400, `${api} stream=${stream}`);
      const error = lastError(text);
      assert.equal(error.message, FREE_CHAT_DETAILS.sellerTooSlowToRead);
      assert.equal(error.reason, FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT);
    }
  });

  void test(`${api}: a seller too slow to finish says so after partial output`, async () => {
    const { status, text } = await call(api, true, true);
    assert.equal(status, 200);
    const error = lastError(text);
    assert.equal(error.message, FREE_CHAT_DETAILS.sellerTooSlowToFinish);
    assert.equal(error.reason, FREE_EXECUTION_STOP_REASONS.ENGINE_TIMEOUT);
  });
}

void test('other seller stops keep their code as the message', async () => {
  const server = await startFreeBuyerHttp(
    () => {
      throw timedOut({
        reason: FREE_EXECUTION_STOP_REASONS.ENGINE_INTERRUPTED,
      });
    },
    { selection: SELECTION, maxTokens: 10 },
    { port: 0 },
  );
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(BODIES.openai(false)),
    });
    const error = (await response.json()).error;
    assert.equal(error.message, FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE);
  } finally {
    await server.close();
  }
});

void test('the slow-seller messages tell the user what to do next', () => {
  assert.match(FREE_CHAT_DETAILS.sellerTooSlowToRead, /too slow/);
  assert.match(FREE_CHAT_DETAILS.sellerTooSlowToRead, /another seller/);
  assert.match(FREE_CHAT_DETAILS.sellerTooSlowToFinish, /another seller/);
});
