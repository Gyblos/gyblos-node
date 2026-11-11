// Pure conversation construction keeps confirmed text exact and refuses bounds without trimming or mutation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHAT_INPUT_BYTES } from '@gyblos/buyer/constants';
import { prepareBuyerConversation } from '@gyblos/core/buyer-conversation';
import type { ChatMessage } from '@gyblos/protocol/chat';
import { FREE_CHAT_ROLES, FREE_EXECUTION } from '@gyblos/protocol/constants';

const history: ChatMessage[] = [
  { role: FREE_CHAT_ROLES.USER, content: 'first' },
  { role: FREE_CHAT_ROLES.ASSISTANT, content: 'answer' },
];
void test('shared conversation builder snapshots exact confirmed turns without mutating the caller', () => {
  const result = prepareBuyerConversation(history, 'next', CHAT_INPUT_BYTES);
  assert.deepEqual(result, [
    ...history,
    { role: FREE_CHAT_ROLES.USER, content: 'next' },
  ]);
  result![0]!.content = 'changed';
  assert.equal(history[0]!.content, 'first');
});
void test('whole history must fit the unchanged UTF-8 input boundary exactly', () => {
  const bytes = new TextEncoder().encode('firstanswernext').byteLength;
  assert.ok(prepareBuyerConversation(history, 'next', bytes));
  assert.equal(prepareBuyerConversation(history, 'next', bytes - 1), undefined);
  assert.ok(prepareBuyerConversation([], 'é', 2));
  assert.equal(prepareBuyerConversation([], 'é', 1), undefined);
  assert.ok(
    prepareBuyerConversation(
      [],
      'x'.repeat(CHAT_INPUT_BYTES),
      CHAT_INPUT_BYTES,
    ),
  );
  assert.equal(
    prepareBuyerConversation(
      [],
      'x'.repeat(CHAT_INPUT_BYTES + 1),
      CHAT_INPUT_BYTES,
    ),
    undefined,
  );
});
void test('message-count limits reject an extra pair without discarding earlier turns', () => {
  const turns: ChatMessage[] = Array.from(
    { length: FREE_EXECUTION.maxMessages - 2 },
    (_, index) => ({
      role: index % 2 === 0 ? FREE_CHAT_ROLES.USER : FREE_CHAT_ROLES.ASSISTANT,
      content: 'x',
    }),
  );
  assert.ok(prepareBuyerConversation(turns, 'next', CHAT_INPUT_BYTES));
  turns.push(...history);
  assert.equal(
    prepareBuyerConversation(turns, 'next', CHAT_INPUT_BYTES),
    undefined,
  );
  assert.equal(turns.length, FREE_EXECUTION.maxMessages);
});
void test('invalid order, empty assistant text and lone surrogates are rejected before sending', () => {
  for (const turns of [
    [history[0]!],
    [{ role: FREE_CHAT_ROLES.ASSISTANT, content: 'wrong' }],
    [history[0]!, { role: FREE_CHAT_ROLES.ASSISTANT, content: '' }],
    [history[0]!, { role: FREE_CHAT_ROLES.ASSISTANT, content: '\ud800' }],
  ])
    assert.equal(
      prepareBuyerConversation(turns, 'next', CHAT_INPUT_BYTES),
      undefined,
    );
  assert.equal(
    prepareBuyerConversation([], '\udfff', CHAT_INPUT_BYTES),
    undefined,
  );
  assert.ok(prepareBuyerConversation([], '😀', CHAT_INPUT_BYTES));
  assert.equal(
    prepareBuyerConversation(history, '  ', CHAT_INPUT_BYTES),
    undefined,
  );
});
