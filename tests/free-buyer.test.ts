// Free buyer policy and HTTP-input regressions; only synthetic input reaches injected executors.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import { FreeClientError } from '@gyblos/transport-iroh/free-client';

import { freeSellerFixture } from './support/free-seller';

void test('free chat accepts only the configured model, one user message and bounded non-streaming output', async () => {
  const api = await import('@gyblos/buyer/free-chat');
  const selection = { modelId: 'synthetic', variant: null, quantization: null };
  const input = {
    model: 'synthetic',
    messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
  };
  assert.equal(api.parseFreeChat(input, selection, 10).maxTokens, 10);
  for (const change of [
    { stream: true },
    { model: 'other' },
    { temperature: 1 },
    { max_tokens: 11 },
    { messages: [{ role: 'system', content: 'hello' }] },
    { messages: [...input.messages, ...input.messages] },
    { messages: [{ role: 'user', content: ['image'] }] },
  ])
    assert.throws(() =>
      api.parseFreeChat({ ...input, ...change }, selection, 10),
    );
});
void test('free buyer retries another seller only after a known pre-send failure', async () => {
  const api = await import('@gyblos/buyer/free-execution');
  const source = await freeSellerFixture();
  const quote = (await source.request()).quote;
  const attempted: string[] = [];
  const result = await api.executeBuyerFree(
    {
      messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
      maxTokens: 10,
    },
    {
      select: async (excluded) => ({
        quote,
        nodeId: excluded.size ? 'second' : 'first',
      }),
      execute: async (winner) => {
        attempted.push(winner.nodeId);
        if (winner.nodeId === 'first')
          throw new FreeClientError(FREE_EXECUTION_CODES.INTERNAL, false);
        return {
          text: 'answer',
          usage: { inputTokens: 4, outputTokens: 2 },
          finishReason: ENGINE_DONE_REASONS.STOP,
        };
      },
    },
  );
  assert.equal(result.text, 'answer');
  assert.deepEqual(attempted, ['first', 'second']);
});
void test('free buyer never retries after partial transmission or a remote refusal', async () => {
  const api = await import('@gyblos/buyer/free-execution');
  const source = await freeSellerFixture();
  const quote = (await source.request()).quote;
  for (const remote of [false, true]) {
    let selections = 0;
    await assert.rejects(
      api.executeBuyerFree(
        {
          messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
          maxTokens: 10,
        },
        {
          select: async () => {
            selections++;
            return { quote, nodeId: 'first' };
          },
          execute: async () => {
            throw new FreeClientError(FREE_EXECUTION_CODES.BUSY, true, remote);
          },
        },
      ),
      { sent: true },
    );
    assert.equal(selections, 1);
  }
});
void test('free buyer refuses a repeated candidate instead of retrying it', async () => {
  const api = await import('@gyblos/buyer/free-execution');
  const source = await freeSellerFixture();
  const quote = (await source.request()).quote;
  let calls = 0;
  await assert.rejects(
    api.executeBuyerFree(
      {
        messages: [{ role: FREE_CHAT_ROLES.USER, content: 'hello' }],
        maxTokens: 10,
      },
      {
        select: async () => ({ quote, nodeId: 'first' }),
        execute: async () => {
          calls++;
          throw new FreeClientError(FREE_EXECUTION_CODES.INTERNAL, false);
        },
      },
    ),
  );
  assert.equal(calls, 1);
});
