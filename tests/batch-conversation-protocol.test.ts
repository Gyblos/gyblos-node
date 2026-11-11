// Pins the versioned conversation transport and complete-history digest without financial effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BATCH_CHANNEL,
  BATCH_METHODS,
  batchExecutionDigest,
  buildBatchExecutionRequest,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import {
  batchConversation,
  CONVERSATION_INPUT,
} from './support/batch-conversation';

void test('paid conversations use session v2 with separate request and reply domains', () => {
  assert.equal(BATCH_CHANNEL.version, 2);
  assert.equal(BATCH_CHANNEL.alpn, 'gyblos/session/2');
  assert.equal(BATCH_CHANNEL.requestDomain, 'gyblos/session-request/v2\n');
  assert.equal(BATCH_CHANNEL.replyDomain, 'gyblos/session-rpc/v2\n');
});

void test('conversation message, content and output bounds are independent of the free profile', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const quote = await f.quote(1, { maxTokens: 129 });
  const channel = '11111111111111111111111111111111';
  assert.throws(
    () =>
      buildBatchExecutionRequest(channel, quote, {
        ...CONVERSATION_INPUT,
        maxTokens: 129,
      }),
    { code: PAID_EXECUTION_CODES.LIMIT },
  );
  assert.throws(
    () =>
      buildBatchExecutionRequest(channel, quote, {
        messages: [{ role: FREE_CHAT_ROLES.USER, content: 'x'.repeat(65537) }],
        maxTokens: 10,
      }),
    { code: PAID_EXECUTION_CODES.LIMIT },
  );
  assert.throws(
    () =>
      buildBatchExecutionRequest(channel, quote, {
        messages: Array.from({ length: 1025 }, (_, index) => ({
          role:
            index % 2 === 0 ? FREE_CHAT_ROLES.USER : FREE_CHAT_ROLES.ASSISTANT,
          content: 'x',
        })),
        maxTokens: 10,
      }),
    { code: PAID_EXECUTION_CODES.INVALID },
  );
  assert.equal(f.rig.calls.length, 0);
  assert.equal(f.generated.length, 0);
});
void test('the full historical content and roles bind the session execution digest', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const quote = await f.quote(1);
  const request = buildBatchExecutionRequest(
    '11111111111111111111111111111111',
    quote,
    CONVERSATION_INPUT,
  );
  const original = await batchExecutionDigest(request);
  const altered = structuredClone(request);
  altered.input.messages[1]!.content = 'changed';
  assert.notEqual(await batchExecutionDigest(altered), original);
  assert.throws(
    () =>
      parseBatchChannelRequest({
        version: 1,
        requestId: '12'.repeat(16),
        method: BATCH_METHODS.EXECUTE,
        params: request,
      }),
    { code: SESSION_CODES.INVALID },
  );
});
