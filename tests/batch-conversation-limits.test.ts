// Boundary, cancellation and legacy-approval recovery cases use synthetic SDK accounts and local streams.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_CHANNEL,
  BatchChannelError,
  batchExecutionDigest,
  buildBatchExecutionRequest,
} from '@gyblos/protocol/batch-channel';
import { FREE_CHAT_ROLES } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import {
  batchConversation,
  CONVERSATION_INPUT,
} from './support/batch-conversation';
import { batchDeferred } from './support/batch-deferred';
import { within } from './support/test-deadline';

void test('history fits exactly at context and budget ceilings without reserving either twice', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  f.offers.live.model = { ...f.offers.live.model, contextTokens: 22 };
  const quote = await f.quote(1, {
    model: f.offers.live.model,
    maxAtomic: '22',
  });
  const result = await f
    .buyer()
    .execute(quote, CONVERSATION_INPUT, new AbortController().signal);
  assert.equal(result.value.usage.inputTokens, 12);
  assert.equal(result.approval.approvedAtomic, '15');
  assert.deepEqual(f.rig.calls, ['deposit']);
});

void test('unsupported or unsafe conversation recount fails before opening a financial service', async (t) => {
  for (const count of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER]) {
    const f = await batchConversation();
    t.after(f.close);
    f.meter.chat = () => count;
    await assert.rejects(
      f
        .buyer()
        .execute(
          await f.quote(1),
          CONVERSATION_INPUT,
          new AbortController().signal,
        ),
      { code: PAID_EXECUTION_CODES.LIMIT },
    );
    assert.equal(f.constructions(), 0);
    assert.equal(f.generated.length, 0);
  }
  const f = await batchConversation();
  t.after(f.close);
  Reflect.deleteProperty(f.meter, 'chat');
  await assert.rejects(
    f
      .buyer()
      .execute(
        await f.quote(1),
        CONVERSATION_INPUT,
        new AbortController().signal,
      ),
    { code: PAID_EXECUTION_CODES.UNSUPPORTED },
  );
  assert.equal(f.constructions(), 0);
});

void test('a cancelled conversational generation never retries or signs a cumulative approval', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const entered = batchDeferred<void>();
  const release = batchDeferred<void>();
  f.offers.generate(async () => {
    entered.resolve();
    await release.promise;
    throw new Error('Synthetic cancelled generation');
  });
  const approve = t.mock.method(f.rig.buyer, 'approve');
  const abort = new AbortController();
  const run = f
    .buyer()
    .execute(await f.quote(1), CONVERSATION_INPUT, abort.signal);
  const rejected = assert.rejects(run, {
    code: PAID_EXECUTION_CODES.CANCELLED,
  });
  try {
    await within(
      Promise.race([
        entered.promise,
        rejected.then(() => assert.fail('Generation phase missing')),
      ]),
      10000,
    );
    abort.abort();
    await rejected;
  } finally {
    abort.abort();
    release.resolve();
    await rejected.catch(() => {});
  }
  await assert.rejects(
    f
      .buyer()
      .execute(
        await f.quote(2),
        CONVERSATION_INPUT,
        new AbortController().signal,
      ),
  );
  assert.equal(f.generated.length, 1);
  assert.equal(approve.mock.callCount(), 0);
  assert.deepEqual(f.rig.calls, ['deposit']);
});

void test('invalid history cannot construct the shared financial pool', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  let constructed = 0;
  const pool = createBuyerSessionPool({
    ...f.wire,
    policy: {
      depositAtomic: '1000',
      totalDepositAtomic: '2000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    },
    inspect: async () => [],
    pool: async () => {
      constructed++;
      return assert.fail('Financial pool must remain unopened');
    },
    destination: () => f.wire.destination,
    meter: f.meter,
    now: f.rig.now,
    unresolved: async () => false,
    verify: async () => {},
  });
  t.after(pool.close);
  await assert.rejects(
    pool.execute(
      await f.quote(1),
      {
        messages: [{ role: FREE_CHAT_ROLES.USER, content: '<|im_start|>' }],
        maxTokens: 10,
      },
      new AbortController().signal,
    ),
    { code: PAID_EXECUTION_CODES.UNSUPPORTED },
  );
  assert.equal(constructed, 0);
  assert.equal(f.generated.length, 0);
  assert.deepEqual(f.rig.calls, []);
});

void test('a session-v1-only peer fails v2 preparation before opening or signing a deposit', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const opening = t.mock.method(f.rig.buyer, 'open');
  const connect = t.mock.method(
    f.wire.endpoint,
    'connect',
    async (...args: Parameters<typeof f.wire.endpoint.connect>) => {
      assert.equal(Buffer.from(args[1]).toString(), BATCH_CHANNEL.alpn);
      throw new BatchChannelError(PAID_EXECUTION_CODES.UNSUPPORTED);
    },
  );
  await assert.rejects(
    f
      .buyer()
      .execute(
        await f.quote(1),
        CONVERSATION_INPUT,
        new AbortController().signal,
      ),
    { code: PAID_EXECUTION_CODES.UNSUPPORTED },
  );
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(opening.mock.callCount(), 0);
  assert.equal(f.generated.length, 0);
  assert.deepEqual(f.rig.calls, []);
});

void test('quote expiry during whole-history recount refuses seller reservation and generation', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  const quote = await f.quote(1);
  const chat = f.offers.live.meter.chat;
  f.offers.live.meter.chat = (messages) => {
    const count = chat(messages);
    f.rig.time(quote.offer.expiresAt);
    return count;
  };
  const reserve = t.mock.method(f.rig.seller(), 'reserve');
  await assert.rejects(
    f.buyer().execute(quote, CONVERSATION_INPUT, new AbortController().signal),
    { code: PAID_EXECUTION_CODES.EXPIRED },
  );
  assert.equal(reserve.mock.callCount(), 0);
  assert.equal(f.generated.length, 0);
  assert.equal(f.rig.seller().snapshot().cumulativeAtomic, '0');
});

void test('a persisted v1 approval recovers over v2 with its original digest and no prompt', async (t) => {
  const f = await batchConversation();
  t.after(f.close);
  await f.rig.open();
  const quote = await f.quote(1);
  const input = {
    messages: [{ role: FREE_CHAT_ROLES.USER, content: 'old' }],
    maxTokens: 10,
  };
  const request = buildBatchExecutionRequest(
    f.rig.buyer.snapshot().channelId,
    quote,
    input,
  );
  const digest = createHash('sha256')
    .update('gyblos/session-request/v1\n' + canonicalJson(request))
    .digest('hex');
  assert.notEqual(digest, await batchExecutionDigest(request));
  const pending = {
    requestId: quote.offer.requestId,
    requestDigest: digest,
    maxAtomic: quote.offer.maxAtomic,
  };
  await f.rig.buyer.begin(pending);
  await f.rig.seller().reserve(pending, f.rig.terms.buyerNodeId);
  const bill = await f.rig.seller().finish(pending.requestId, '5');
  await f.rig.buyer.approve(bill, '5');
  await f.restart();
  assert.equal(await f.buyer().unresolved(), false);
  assert.equal(f.rig.seller().snapshot().cumulativeAtomic, '5');
  assert.equal(f.generated.length, 0);
  assert.deepEqual(f.rig.calls, ['deposit']);
  const settled = await f.buyer().settle(new AbortController().signal);
  assert.equal(settled!.chargedAtomic, '5');
  assert.equal(settled!.refundedAtomic, '995');
  assert.equal(f.generated.length, 0);
});
