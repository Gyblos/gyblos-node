// Recovery follows durable block state without a tokenizer; new execution still requires prefix verification.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuyerBatchSession } from '@gyblos/node/batch-buyer';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { blockProduct, blockTestMeter } from './support/batch-block-product';

void test('a restored block channel refuses fresh inference without prefix verification before connecting', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  await f.buyer.execute(await f.offers.quote(1), f.offers.input);
  const client = createBuyerBatchSession({
    ...f.wire,
    buyer: f.f.buyer,
    terms: f.f.terms,
    meter: {
      input: blockTestMeter.input,
      chat: blockTestMeter.chat,
      count: blockTestMeter.count,
    },
    now: f.f.now,
    unresolved: async () => false,
    verify: async () => {},
    observe: f.f.sellerOptions.observe,
  });
  const connections = f.wire.connections();
  try {
    await assert.rejects(
      client.execute(await f.offers.quote(2), f.offers.input),
      { code: PAID_EXECUTION_CODES.UNSUPPORTED },
    );
    assert.equal(f.wire.connections(), connections);
    assert.equal(f.offers.generations(), 1);
    assert.deepEqual(f.f.calls, ['deposit']);
  } finally {
    await client.disconnect();
    await client.settled();
  }
});
