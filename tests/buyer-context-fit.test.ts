import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_BUYER_CODES } from '@gyblos/buyer/constants';
import { FreeBuyerError } from '@gyblos/buyer/free-chat';
import { executeBuyerFree } from '@gyblos/buyer/free-execution';
import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import type { FreeExecutionRequest } from '@gyblos/protocol/free-execution';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { CODEX, host } from './support/buyer-responses';
import { freeSellerFixture } from './support/free-seller';

const QUOTE = (await (await freeSellerFixture()).request()).quote;
const withContext = (contextTokens: number) => ({
  ...QUOTE,
  offer: {
    ...QUOTE.offer,
    maxTokens: 4096,
    model: { ...QUOTE.offer.model, contextTokens },
  },
});
const ANSWER = {
  text: 'ok',
  usage: { inputTokens: 1, outputTokens: 1 },
  finishReason: ENGINE_DONE_REASONS.STOP,
};
const input = (bytes: number, maxTokens: number) => ({
  messages: [{ role: 'user' as const, content: 'x'.repeat(bytes) }],
  maxTokens,
});

function rig(contexts: Record<string, number>) {
  const asked: { nodeId: string; maxTokens: number }[] = [];
  return {
    asked,
    dependencies: {
      select: async (excluded: ReadonlySet<string>) => {
        const next = Object.keys(contexts).find((id) => !excluded.has(id));
        if (!next) throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
        return { nodeId: next, quote: withContext(contexts[next]!) };
      },
      execute: async (
        winner: { nodeId: string },
        request: FreeExecutionRequest,
      ) => {
        asked.push({
          nodeId: winner.nodeId,
          maxTokens: request.input.maxTokens,
        });
        return ANSWER;
      },
    },
  };
}

void test('the answer limit is lowered to what fits in the chosen seller context', async () => {
  const { dependencies, asked } = rig({ a: 4096 });
  await executeBuyerFree(input(3000, 4096), dependencies);
  assert.equal(asked.length, 1);
  assert.ok(asked[0]!.maxTokens < 4096 - 1000);
  assert.ok(asked[0]!.maxTokens > 0);
});

void test('an answer limit that already fits is left as asked', async () => {
  const { dependencies, asked } = rig({ a: 32768 });
  await executeBuyerFree(input(30, 256), dependencies);
  assert.equal(asked[0]!.maxTokens, 256);
});

void test('a seller whose context cannot hold the conversation is skipped before the prompt is sent', async () => {
  const { dependencies, asked } = rig({ small: 1000, large: 32768 });
  await executeBuyerFree(input(6000, 4096), dependencies);
  assert.deepEqual(
    asked.map(({ nodeId }) => nodeId),
    ['large'],
  );
});

void test('when no seller can hold the conversation the client is told its context is full', async () => {
  const { dependencies, asked } = rig({ a: 1000, b: 2000 });
  await assert.rejects(
    executeBuyerFree(input(9000, 4096), dependencies),
    (error: unknown) =>
      error instanceof FreeClientError &&
      error.code === FREE_EXECUTION_CODES.LIMIT &&
      !error.sent,
  );
  assert.equal(asked.length, 0);
});

const tooLong = new FreeClientError(FREE_EXECUTION_CODES.LIMIT, true, true);
const messagesUrl = (url: string) =>
  url.replace(/\/v1\/chat\/completions$/, '/v1/messages');

void test('a full context is reported with the OpenAI code coding agents compact on', async () => {
  const server = await host(async () => {
    throw tooLong;
  }, []);
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CODEX.model,
        messages: [{ role: 'user', content: 'a long conversation' }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'context_length_exceeded');
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /maximum context length/);
    assert.equal(body.error.gyblos_code, FREE_EXECUTION_CODES.LIMIT);
  } finally {
    await server.close();
  }
});

void test('a full context is reported in the words Anthropic clients compact on', async () => {
  const server = await host(async () => {
    throw tooLong;
  }, []);
  try {
    const response = await fetch(messagesUrl(server.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: CODEX.model,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'a long conversation' }],
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /^prompt is too long/);
  } finally {
    await server.close();
  }
});
