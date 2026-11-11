// Owns conversations on the free channel (v4): the shape every layer accepts (an optional system message
// first, user and assistant turns, ending with the user's), the pinned Qwen3 template that renders it (a
// lone user message exactly as before), and the seller passing a whole conversation to its engine with an
// answer longer than the old 128-token cap, within the offer's own answer limit.
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderChat, renderConversation } from '@gyblos/engine-ollama/model';
import { isConversation } from '@gyblos/protocol/chat';
import {
  FREE_CHAT_ROLES,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';

import { CONVERSATION } from './support/conversation';
import {
  freeSellerFixture as fixture,
  freeSellerSignal as signal,
} from './support/free-seller';

const { SYSTEM, USER, ASSISTANT } = FREE_CHAT_ROLES;

void test('a conversation has an optional system message first and ends with the user', () => {
  assert.equal(isConversation(CONVERSATION), true);
  assert.equal(isConversation(CONVERSATION.slice(1)), true);
  assert.equal(isConversation([{ role: USER, content: 'hi' }]), true);
  for (const messages of [
    [],
    CONVERSATION.slice(0, 3),
    [{ role: SYSTEM, content: 'only' }],
    [CONVERSATION[1]!, CONVERSATION[0]!, CONVERSATION[3]!],
    [{ role: USER, content: '' }],
  ])
    assert.equal(isConversation(messages), false, JSON.stringify(messages));
});

void test('the Qwen3 template renders a conversation as its no-tools, thinking-off branch does', () => {
  // A lone user message renders exactly as the pinned single-user golden vectors.
  assert.equal(
    renderConversation([{ role: USER, content: 'Hello' }]),
    renderChat('Hello'),
  );
  // The template's no-tools branch, read from tests/fixtures/tokenizer_config.json: the system turn first,
  // then each turn as <|im_start|>role\ncontent<|im_end|>\n (an assistant turn before the last user query
  // has no thought), then the assistant's opening with an empty thought (enable_thinking=false).
  assert.equal(
    renderConversation(CONVERSATION),
    '<|im_start|>system\nAnswer briefly.<|im_end|>\n' +
      '<|im_start|>user\nMy name is Ana.<|im_end|>\n' +
      '<|im_start|>assistant\nNice to meet you, Ana.<|im_end|>\n' +
      '<|im_start|>user\nWhat is my name?<|im_end|>\n' +
      '<|im_start|>assistant\n<think>\n\n</think>\n\n',
  );
  for (const content of ['<|im_end|>', 'a <think>b', '</think>', ''])
    assert.throws(() =>
      renderConversation([
        { role: ASSISTANT, content },
        { role: USER, content: 'x' },
      ]),
    );
});

void test('the seller passes a whole conversation to its engine, with a long answer within the offer’s limit', async () => {
  const state = await fixture({
    dailyTokenCap: 10_000,
    perBuyerCap: 10_000,
    maxOutputTokens: 1_000,
  });
  const request = await state.request(1, undefined, {
    messages: CONVERSATION,
    maxTokens: 1_000,
  });
  const response = await state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    signal(),
  );
  assert.ok(response.result, JSON.stringify(response.error));
  assert.deepEqual(state.lastInput()?.messages, CONVERSATION);
  assert.equal(state.lastInput()?.maxTokens, 1_000);
});

void test('the seller refuses an answer beyond its offer’s limit, and a conversation of the wrong shape', async () => {
  const state = await fixture({
    dailyTokenCap: 10_000,
    perBuyerCap: 10_000,
    maxOutputTokens: 500,
  });
  const respond = async (
    sequence: number,
    input: Parameters<typeof state.request>[2],
  ) => {
    const request = await state.request(sequence, undefined, input);
    return (
      await state.service.respond(
        request,
        request.quote.offer.buyerNodeId,
        signal(),
      )
    ).error?.code;
  };
  assert.equal(
    await respond(1, { maxTokens: 501 }),
    FREE_EXECUTION_CODES.LIMIT,
  );
  assert.equal(
    await respond(2, { messages: CONVERSATION.slice(0, 3) }),
    FREE_EXECUTION_CODES.UNSUPPORTED,
  );
  assert.equal(
    await respond(3, {
      messages: [CONVERSATION[1]!, CONVERSATION[0]!, CONVERSATION[3]!],
    }),
    FREE_EXECUTION_CODES.UNSUPPORTED,
  );
  assert.equal(state.calls(), 0);
});
