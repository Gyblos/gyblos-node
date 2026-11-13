// Only a complete bounded SSE answer exposes raw text for history; provisional output is display-only.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatTurn } from '@gyblos/buyer/chat-cli-turn';
import { CHAT_TURN_STATUSES } from '@gyblos/buyer/constants';
import {
  ENGINE_DONE_REASONS,
  FREE_EXECUTION,
} from '@gyblos/protocol/constants';

const delta = (content: unknown) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
const terminal = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: ENGINE_DONE_REASONS.STOP }], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\n`;
const end = 'data: [DONE]\n\n';
async function turn(body: string) {
  let output = '';
  const result = await chatTurn(
    {
      model: 'synthetic',
      maxTokens: 8,
      prompt: 'synthetic',
      write: (text) => {
        output += text;
      },
    },
    async () =>
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
  return { result, output };
}
void test('confirmed history keeps exact raw text while terminal escape sequences remain hidden', async () => {
  const raw = '\u001b[31manswer\n';
  const { result, output } = await turn(delta(raw) + terminal + end);
  assert.equal(result.status, CHAT_TURN_STATUSES.COMPLETE);
  if (result.status !== CHAT_TURN_STATUSES.COMPLETE)
    assert.fail('Expected confirmed text');
  assert.equal(result.text, raw);
  assert.equal(output.includes('\u001b'), false);
});
void test('missing completion, trailing bytes and remote errors never expose history text', async () => {
  for (const body of [
    delta('partial'),
    delta('partial') + terminal,
    delta('partial') + terminal + end + 'trailing',
    delta('partial') + 'data: {"error":{"message":"private"}}\n\n',
  ]) {
    const { result } = await turn(body);
    assert.equal(result.status, CHAT_TURN_STATUSES.UNCERTAIN);
    assert.equal(Object.hasOwn(result, 'text'), false);
  }
});
void test('decoded history output obeys the existing protocol byte cap, including escaped content', async () => {
  const exact = await turn(
    delta('x'.repeat(FREE_EXECUTION.outputBytes)) + terminal + end,
  );
  assert.equal(exact.result.status, CHAT_TURN_STATUSES.COMPLETE);
  const excess = await turn(
    delta('\u0001'.repeat(FREE_EXECUTION.outputBytes + 1)) + terminal + end,
  );
  assert.equal(excess.result.status, CHAT_TURN_STATUSES.UNCERTAIN);
  assert.equal(Object.hasOwn(excess.result, 'text'), false);
});
void test('invalid text deltas do not become apparently complete history', async () => {
  for (const content of [17, '\ud800']) {
    const { result } = await turn(delta(content) + terminal + end);
    assert.equal(result.status, CHAT_TURN_STATUSES.UNCERTAIN);
    assert.equal(Object.hasOwn(result, 'text'), false);
  }
});

void test('unsupported finish reasons never confirm conversation history', async () => {
  const { result } = await turn(
    delta('answer') +
      terminal.replace(ENGINE_DONE_REASONS.STOP, 'tool_calls') +
      end,
  );
  assert.equal(result.status, CHAT_TURN_STATUSES.UNCERTAIN);
  assert.equal(Object.hasOwn(result, 'text'), false);
});
