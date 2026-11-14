// Real TCP streams and financial ports enforce a duplex checkpoint handshake without prompt retries.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { chargeV2 } from '@gyblos/core/pricing-v2';
import { BATCH_CHANNEL, BATCH_METHODS, buildBatchExecutionRequest, type BatchChannelRequest } from '@gyblos/protocol/batch-channel';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import {
  sessionBlockDigest,
  sessionBlockRequestDigest,
  SESSION_BLOCK_KINDS,
  SESSION_BLOCKS,
  type SessionCheckpoint,
  type SessionBlockIntent,
} from '@gyblos/protocol/session-blocks';
import { createBatchChannelClient, type BatchBlockClient } from '@gyblos/transport-iroh/batch-client';

import { batchDeferred } from './support/batch-deferred';
import { batchOfferFixture } from './support/batch-iroh-offer';
import { batchLoopback } from './support/batch-loopback';
import { sessionRig } from './support/batch-session';

async function fixture(t: TestContext) {
  const f = await sessionRig();t.after(f.dispose);await f.open();
  const offers = await batchOfferFixture(f.terms, f.owner, f.now);const quote = await offers.quote(1);
  const execution = buildBatchExecutionRequest(f.buyer.snapshot().channelId, quote, offers.input);
  const pending = { requestId: execution.requestId, requestDigest: await sessionBlockRequestDigest(execution), maxAtomic: quote.offer.maxAtomic };
  await f.buyer.beginBlocks(pending);
  const prepared: SessionBlockIntent[] = [];
  let calls = 0;
  const wire = await batchLoopback({
    async exchange(request, peer, _signal, _onDelta, blocks) {
      assert.equal(request.method, BATCH_METHODS.EXECUTE);assert.ok(blocks);
      calls++;await f.seller().reserveBlocks(pending, peer);
      let last: SessionCheckpoint | undefined;
      try {
        for (let index = 0; index < 2; index++) {
          const terminal = index === 1;
          const usage = { inputTokens: 2, outputTokens: terminal ? 3 : 1 };
          const amount = String(chargeV2({ input: 2, output: usage.outputTokens }, quote.offer.prices));
          const checkpoint: SessionCheckpoint = {
            version: SESSION_BLOCKS.version, channelId: execution.channelId,
            requestId: pending.requestId, requestDigest: pending.requestDigest, index, kind: SESSION_BLOCK_KINDS.CHECKPOINT,
            text: terminal ? 'b' : 'a ', usage,
            bill: { ...pending, chargedAtomic: amount, cumulativeAtomic: amount },
            terminal: terminal ? { text: 'a b', usage, finishReason: ENGINE_DONE_REASONS.STOP } : null,
          };
          const intent = { index, digest: await sessionBlockDigest(checkpoint), usage, bill: checkpoint.bill, terminal };
          await f.seller().checkpoint(intent);prepared.push(intent);
          await blocks(checkpoint, (voucher) => f.seller().acceptBlock(intent, voucher, peer));last = checkpoint;
        }
        assert.ok(last?.terminal);return { value: last.terminal, bill: last.bill };
      } finally { await f.seller().releaseBlocks(pending.requestId); }
    },
  }, f.terms, true);
  t.after(wire.close);
  const client = createBatchChannelClient(wire.endpoint, wire.destination, f.terms.sellerNodeId, { blocks: true, now: f.now });
  t.after(async () => { await client.close();await client.settled(); });
  let approve = async (_intent: SessionBlockIntent) => {};
  const blockClient: BatchBlockClient = {
    verification: {
      binding: { channelId: execution.channelId, ...pending }, request: pending, baseAtomic: '0', depositAtomic: f.terms.depositAtomic, maxTokens: 10,
      verify: async (text, terminal) => {
        const outputTokens = terminal ? text.length : text.length - 1;
        return { inputTokens: 2, outputTokens, chargedAtomic: String(chargeV2({ input: 2, output: outputTokens }, quote.offer.prices)) };
      },
    },
    approve: async (intent, check) => { await approve(intent);return f.buyer.approveBlock(intent, intent.bill.chargedAtomic, check); },
    acknowledge: (intent) => f.buyer.acknowledgeBlock(intent),
  };
  const request: BatchChannelRequest = { version: BATCH_CHANNEL.version, requestId: '44'.repeat(16), method: BATCH_METHODS.EXECUTE, params: execution };
  return { f, prepared, calls: () => calls, approve: (next: typeof approve) => { approve = next; },
    execute: (signal?: AbortSignal) => client.exchange(request, signal, undefined, blockClient),
  };
}
void test('two response blocks share one duplex execution and settle only the verified total', async (t) => {
  const f = await fixture(t);const response = await f.execute();
  assert.ok(response.result && 'value' in response.result);assert.equal(response.result.value.text, 'a b');
  assert.equal(f.calls(), 1);assert.equal(f.prepared.length, 2);assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '40');
  assert.equal(f.f.buyer.snapshot().reservedAtomic, '0');assert.deepEqual(f.f.calls, ['deposit']);
});
void test('the seller cannot publish the next block before the first approval and durable acceptance', async (t) => {
  const f = await fixture(t);const entered = batchDeferred<void>();const release = batchDeferred<void>();
  f.approve(async (intent) => { if (intent.index === 0) { entered.resolve();await release.promise; } });
  const running = f.execute();void running.catch(() => {});
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('execution ended before approval'); })]);
    assert.equal(f.prepared.length, 1);assert.equal(f.f.seller().snapshot().cumulativeAtomic, '0');
  } finally { release.resolve(); }
  await running;assert.equal(f.prepared.length, 2);assert.equal(f.calls(), 1);
});
