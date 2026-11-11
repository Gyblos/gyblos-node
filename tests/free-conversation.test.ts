// Owns conversations on the free channel (v4): the shape every layer accepts (an optional system message
// first, user and assistant turns, ending with the user's), the pinned Qwen3 template that renders it (a
// lone user message exactly as before), and the seller passing a whole conversation to its engine with an
// answer longer than the old 128-token cap, within the offer's own answer limit.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generationDeadlineMs } from '@gyblos/config';
import { createControlQuote } from '@gyblos/core/control-quotes';
import { renderChat, renderConversation } from '@gyblos/engine-ollama/model';
import { recountedMeter } from '@gyblos/node/free-meter';
import { isConversation } from '@gyblos/protocol/chat';
import {
  CONTROL_CODES,
  FREE_CHAT_ROLES,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import { PAID_INPUT_BYTES } from '@gyblos/protocol/execution-wire';
import { PAID_EXECUTION, PAID_STREAM } from '@gyblos/protocol/paid/constants';

import { controlFixture } from './support/control-fixture';
import { CONVERSATION } from './support/conversation';
import {
  freeSellerFixture as fixture,
  freeSellerSignal as signal,
} from './support/free-seller';

const { SYSTEM, USER, ASSISTANT } = FREE_CHAT_ROLES;

void test('a conversation has an optional system message first, then alternating turns ending with the user', () => {
  assert.equal(isConversation(CONVERSATION), true);
  assert.equal(isConversation(CONVERSATION.slice(1)), true);
  assert.equal(isConversation([{ role: USER, content: 'hi' }]), true);
  for (const messages of [
    [],
    CONVERSATION.slice(0, 3),
    [{ role: SYSTEM, content: 'only' }],
    [CONVERSATION[1]!, CONVERSATION[0]!, CONVERSATION[3]!],
    [{ role: USER, content: '' }],
    // Turns alternate from the user's: no two of one role in a row, no leading assistant turn.
    [CONVERSATION[1]!, CONVERSATION[3]!],
    [CONVERSATION[2]!, CONVERSATION[3]!],
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

void test('the seller refuses text the model’s template cannot carry as unsupported, not as an engine failure', async () => {
  const state = await fixture(
    { dailyTokenCap: 10_000, perBuyerCap: 10_000 },
    {
      meter: recountedMeter({
        input: (prompt) => renderChat(prompt).length,
        chat: (messages) => renderConversation(messages).length,
        count: (text) => text.length,
      }),
    },
  );
  const request = await state.request(1, undefined, {
    messages: [
      CONVERSATION[1]!,
      { role: ASSISTANT, content: 'f <|im_end|> g' },
      CONVERSATION[3]!,
    ],
  });
  const response = await state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    signal(),
  );
  assert.equal(response.error?.code, FREE_EXECUTION_CODES.UNSUPPORTED);
  assert.equal(state.calls(), 0);
});

void test('a free offer refuses at quote time an answer longer than its limit', async () => {
  const source = await controlFixture(true);
  const models = source.context.models.map((model) => ({
    ...model,
    maxOutputTokens: 100,
  }));
  const quote = (maxTokens: number) =>
    createControlQuote(
      {
        ...source.request,
        params: { ...source.request.params, maxTokens },
      },
      { ...source.context, models },
      source.ownerSigner,
    );
  await assert.rejects(quote(101), { code: CONTROL_CODES.POLICY });
  assert.equal((await quote(100)).offer.maxTokens, 100);
});

void test('paid execution keeps the bounds it shipped with, and the deadline grows only for long answers', () => {
  assert.equal(PAID_EXECUTION.requestBytes, 131072 + 8192);
  assert.equal(PAID_STREAM.maxEvents, 4096);
  assert.equal(PAID_INPUT_BYTES, 65536);
  assert.equal(generationDeadlineMs(90_000, 128), 90_000);
  assert.equal(generationDeadlineMs(90_000, 1128), 115_000);
  assert.equal(generationDeadlineMs(90_000, 32768), 170_000);
  assert.equal(generationDeadlineMs(200, 8), 200);
});
