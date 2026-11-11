// Conversational usage is independently verified before cumulative approval; all services are synthetic.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import {
  batchConversation,
  CONVERSATION,
  CONVERSATION_INPUT,
} from './support/batch-conversation';

void test('paid history reaches the engine intact and two turns share one deposit and cumulative approval', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  for (let index = 1; index <= 2; index++) {
    const result = await f
      .buyer()
      .execute(
        await f.quote(index),
        CONVERSATION_INPUT,
        new AbortController().signal,
      );
    assert.deepEqual(f.generated[index - 1]!.messages, CONVERSATION);
    assert.equal(f.generated[index - 1]!.prompt, undefined);
    assert.equal(result.value.usage.inputTokens, 12);
    assert.equal(result.approval.approvedAtomic, '15');
    assert.equal(result.approval.cumulativeAtomic, String(index * 15));
  }
  assert.deepEqual(f.rig.calls, ['deposit']);
  assert.equal(f.constructions(), 1);
  const record = await readFile(f.rig.buyerOptions.paths.state, 'utf8');
  assert.ok(!record.includes('"messages"') && !record.includes('"content"'));
});

void test('paid history rejects invalid turns and model template controls before financial construction', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const cases = [
    [{ role: FREE_CHAT_ROLES.ASSISTANT, content: 'a' }],
    [
      { role: FREE_CHAT_ROLES.USER, content: 'u' },
      { role: FREE_CHAT_ROLES.USER, content: 'v' },
    ],
    [{ role: FREE_CHAT_ROLES.SYSTEM, content: 's' }],
    [{ role: FREE_CHAT_ROLES.USER, content: '<|im_start|>' }],
  ];
  for (const messages of cases)
    await assert.rejects(
      f
        .buyer()
        .execute(
          await f.quote(1),
          { messages, maxTokens: 10 },
          new AbortController().signal,
        ),
      { code: PAID_EXECUTION_CODES.UNSUPPORTED },
    );
  assert.equal(f.constructions(), 0);
  assert.deepEqual(f.rig.calls, []);
  assert.equal(f.generated.length, 0);
});

void test('all historical input tokens count toward context and budget before opening a channel', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const quote = await f.quote(1, { maxAtomic: '21' });
  await assert.rejects(
    f.buyer().execute(quote, CONVERSATION_INPUT, new AbortController().signal),
    { code: PAID_EXECUTION_CODES.BUDGET_EXHAUSTED },
  );
  const tooLarge = {
    messages: [
      {
        role: FREE_CHAT_ROLES.USER,
        content: 'x'.repeat(quote.offer.model.contextTokens),
      },
    ],
    maxTokens: 10,
  };
  await assert.rejects(
    f.buyer().execute(await f.quote(2), tooLarge, new AbortController().signal),
    { code: PAID_EXECUTION_CODES.LIMIT },
  );
  assert.equal(f.constructions(), 0);
  assert.deepEqual(f.rig.calls, []);
  assert.equal(f.generated.length, 0);
});

void test('usage that counts only the last turn cannot create a cumulative voucher', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  f.alterUsage();
  const approve = t.mock.method(f.rig.buyer, 'approve');
  await assert.rejects(
    f
      .buyer()
      .execute(
        await f.quote(1),
        CONVERSATION_INPUT,
        new AbortController().signal,
      ),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(approve.mock.callCount(), 0);
  assert.equal(f.generated.length, 1);
});

void test('lost conversational approval ACK recovers after restart without another generation or deposit', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  f.loseAck();
  await assert.rejects(
    f
      .buyer()
      .execute(
        await f.quote(1),
        CONVERSATION_INPUT,
        new AbortController().signal,
      ),
  );
  assert.equal(f.generated.length, 1);
  await f.restart();
  assert.equal(await f.buyer().unresolved(), false);
  assert.equal(f.generated.length, 1);
  assert.deepEqual(f.rig.calls, ['deposit']);
  assert.equal((await f.inspect())!.snapshot.cumulativeAtomic, '15');
  const result = await f
    .buyer()
    .execute(
      await f.quote(2),
      CONVERSATION_INPUT,
      new AbortController().signal,
    );
  assert.equal(result.approval.cumulativeAtomic, '30');
  assert.equal(f.generated.length, 2);
});
