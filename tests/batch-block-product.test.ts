// Real product quote checks, generation pipeline and financial adapters use duplex approvals on one inference.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { BLOCK_TEXT, blockProduct } from './support/batch-block-product';
import { blockJson } from './support/block-json';

void test('product buyer and seller verify each block through the shared generation pipeline', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  const chunks: string[] = [];
  const value = await f.buyer.execute(
    await f.offers.quote(1),
    f.offers.input,
    undefined,
    async (text) => {
      chunks.push(text);
    },
  );
  assert.equal(value.text, BLOCK_TEXT);
  assert.deepEqual(chunks, ['aa ', 'bb ', 'cc']);
  assert.equal(f.offers.generations(), 1);
  assert.deepEqual(f.f.calls, ['deposit']);
  const raw = blockJson(
    JSON.parse(await readFile(f.f.buyerOptions.paths.state, 'utf8')),
  );
  assert.equal(raw.version, 2);
  const requests = blockJson(raw.requests);
  assert.equal(Object.keys(requests).length, 1);
  const request = blockJson(Object.values(requests)[0]);
  assert.equal(request.accepted, true);
  assert.equal(f.f.buyer.snapshot().reservedAtomic, '0');
  assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '80');
});
void test('a second product inference reuses the same deposit and adds its exact cumulative cost', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  for (const index of [1, 2])
    await f.buyer.execute(await f.offers.quote(index), f.offers.input);
  assert.equal(f.offers.generations(), 2);
  assert.deepEqual(f.f.calls, ['deposit']);
  assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '160');
  const closed = await f.buyer.close();
  assert.equal(closed.chargedAtomic, '160');
  assert.equal(closed.refundedAtomic, '840');
});
void test('cancelling after a block ACK recovers that attempt and closes only its signed prefix without replay', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  const controller = new AbortController();
  let delivered = 0;
  await assert.rejects(
    f.buyer.execute(
      await f.offers.quote(1),
      f.offers.input,
      controller.signal,
      async () => {
        delivered++;
        controller.abort();
      },
    ),
  );
  await f.buyer.settled();
  await f.wire.settled();
  assert.equal(delivered, 1);
  assert.equal(f.offers.generations(), 1);
  assert.equal(await f.buyer.recoverApproval(), true);
  assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '32');
  assert.equal(f.f.buyer.snapshot().reservedAtomic, '0');
  const closed = await f.buyer.reconcile();
  assert.equal(closed?.chargedAtomic, '32');
  assert.equal(closed?.refundedAtomic, '968');
  assert.equal(f.offers.generations(), 1);
  assert.deepEqual(f.f.calls, ['deposit', 'refund']);
});
void test('engine failure after one ACK settles only the certified prefix and never starts another generation', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  f.offers.generate(async (input) => {
    await input.onText?.('aa ');
    throw new Error('Synthetic engine interruption');
  });
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: PAID_EXECUTION_CODES.ENGINE },
  );
  await f.buyer.settled();
  await f.wire.settled();
  assert.equal(await f.buyer.recoverApproval(), true);
  assert.equal((await f.buyer.reconcile())?.chargedAtomic, '32');
  assert.equal(f.offers.generations(), 1);
});
void test('a lost block ACK recovers the exact durable voucher and does not bill the same prefix twice', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  const original = f.f.seller().acceptBlock.bind(f.f.seller());
  t.mock.method(
    f.f.seller(),
    'acceptBlock',
    async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('Synthetic lost ACK');
    },
  );
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
  );
  await f.buyer.settled();
  await f.wire.settled();
  assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '32');
  assert.equal(f.f.seller().snapshot().cumulativeAtomic, '32');
  assert.equal(await f.buyer.recoverApproval(), true);
  const settled = await f.buyer.reconcile();
  assert.equal(settled?.chargedAtomic, '32');
  assert.equal(settled?.refundedAtomic, '968');
  assert.equal(f.offers.generations(), 1);
  assert.deepEqual(f.f.calls, ['deposit', 'refund']);
});
void test('text without a certified boundary is one terminal block with the exact final count', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  const text = 'abcdef';
  f.offers.generate(async (input) => {
    for (const value of text) await input.onText?.(value);
    return {
      text,
      finishReason: ENGINE_DONE_REASONS.STOP,
      usage: {
        inputTokens: 2,
        outputTokens: 6,
        totalDurationNs: 0,
        loadDurationNs: 0,
        inputDurationNs: 0,
        outputDurationNs: 0,
      },
    };
  });
  const chunks: string[] = [];
  await f.buyer.execute(
    await f.offers.quote(1),
    f.offers.input,
    undefined,
    async (value) => {
      chunks.push(value);
    },
  );
  assert.deepEqual(chunks, [text]);
  assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '64');
  assert.equal(f.offers.generations(), 1);
});
void test('an expired interrupted channel reconciles its final settlement instead of retrying an expired approval', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  const controller = new AbortController();
  await assert.rejects(
    f.buyer.execute(
      await f.offers.quote(1),
      f.offers.input,
      controller.signal,
      async () => {
        controller.abort();
      },
    ),
  );
  await f.buyer.settled();
  await f.wire.settled();
  f.f.time(f.f.terms.expiresAt + 1);
  await f.f.seller().tick();
  assert.equal(await f.buyer.recoverApproval(), true);
  assert.equal((await f.buyer.reconcile())?.chargedAtomic, '32');
  assert.equal(f.f.buyer.snapshot().reservedAtomic, '0');
  assert.equal(f.offers.generations(), 1);
});
void test('an expired intent without a voucher or settlement cannot create a fresh signature during recovery', async (t) => {
  const f = await blockProduct();t.after(f.close);
  const original = f.f.buyer.approveBlock.bind(f.f.buyer);
  t.mock.method(f.f.buyer, 'approveBlock', async (...args: Parameters<typeof original>) => {
    let checks = 0;
    return original(args[0], args[1], () => { args[2]?.();if (++checks === 2) throw new Error('Synthetic stop after intent, before signature'); });
  });
  await assert.rejects(f.buyer.execute(await f.offers.quote(1), f.offers.input));
  await f.buyer.settled();await f.wire.settled();assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '0');
  let signaturesRecovered = 0;
  const recover = f.f.buyer.recoverBlockApproval.bind(f.f.buyer);
  t.mock.method(f.f.buyer, 'recoverBlockApproval', async () => { signaturesRecovered++;return recover(); });
  f.f.time(f.f.terms.expiresAt + 1);
  assert.equal(await f.buyer.recoverApproval(), true);
  assert.equal(signaturesRecovered, 0);assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '0');
  const settled = await f.buyer.reconcile();assert.equal(settled?.chargedAtomic, '0');assert.equal(settled?.refundedAtomic, '1000');
  assert.equal(f.offers.generations(), 1);
});
