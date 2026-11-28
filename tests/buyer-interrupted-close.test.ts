import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BUYER_CHANNEL_DIAGNOSTICS } from '@gyblos/node/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { blockProduct } from './support/batch-block-product';

void test('automatic renewal settles a delivered partial reply before the next agent turn', async (t) => {
  const f = await blockProduct({ settleInterrupted: true });
  t.after(f.close);
  f.offers.generate(async (input) => {
    await input.onText?.('aa ');
    throw new Error('Synthetic engine interruption');
  });
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    { code: PAID_EXECUTION_CODES.ENGINE },
  );
  const proof = await f.buyer.reconcile();
  assert.equal(proof?.chargedAtomic, '32');
  assert.equal(proof?.refundedAtomic, '968');
  assert.deepEqual(f.f.calls, ['deposit', 'refund']);
  assert.equal(f.offers.generations(), 1);
});

void test('a failed close preserves the interrupted stream error and reports only the static cleanup code', async (t) => {
  const canary = 'synthetic-private-close-canary';
  const codes: string[] = [];
  const records: string[] = [];
  const f = await blockProduct({
    settleInterrupted: true,
    diagnostics(record) {
      codes.push(record.code);
      records.push(JSON.stringify(record));
      throw new Error(canary);
    },
  });
  t.after(f.close);
  t.mock.method(f.f.seller(), 'close', async () => {
    throw new Error(canary);
  });
  f.offers.generate(async (input) => {
    await input.onText?.('aa ');
    throw new Error('Synthetic engine interruption');
  });
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1), f.offers.input),
    {
      code: PAID_EXECUTION_CODES.ENGINE,
    },
  );
  assert.deepEqual(codes, [BUYER_CHANNEL_DIAGNOSTICS.code]);
  assert.equal(records.join('').includes(canary), false);
  assert.equal(await f.buyer.reconcile(), undefined);
  assert.deepEqual(f.f.calls, ['deposit']);
  assert.equal(f.offers.generations(), 1);
});
