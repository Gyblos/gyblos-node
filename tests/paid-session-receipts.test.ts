// Receipt observations follow terminal verification, preserve cumulative rounding and never retry generation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type PaidSellerReceiptInput } from '@gyblos/core/receipts';
import type { BuyerReceiptEvidence } from '@gyblos/node/receipts';
import { ENGINE_KINDS } from '@gyblos/protocol/constants';
import { sessionBlockRequestDigest } from '@gyblos/protocol/session-blocks';

import { blockProduct } from './support/batch-block-product';

void test('block receipts bind the execution digest and attribute fees across requests instead of rounding each separately', async (t) => {
  const seller: PaidSellerReceiptInput[] = [];
  const buyer: BuyerReceiptEvidence[] = [];
  const f = await blockProduct({
    receipts: () => ({
      engineKind: ENGINE_KINDS.OLLAMA,
      publisher: {
        publish: (input) => {
          seller.push(input);
        },
      },
    }),
    receipt: (input) => {
      buyer.push(input);
    },
  });
  t.after(f.close);
  f.offers.base.prices.inputAtomicPerMtok = '7000000';
  f.offers.base.prices.outputAtomicPerMtok = '7000000';
  for (let index = 1; index <= 2; index++) {
    const quote = await f.offers.quote(index);
    await f.buyer.execute(quote, f.offers.input, new AbortController().signal);
    assert.equal(seller.length, index);
    assert.equal(buyer.length, index);
    const snapshot = f.f.buyer.snapshot();
    const request = {
      channelId: snapshot.channelId!,
      requestId: quote.offer.requestId,
      quote,
      input: {
        ...f.offers.input,
        selection: quote.offer.selection,
        reasoning: quote.offer.reasoning,
      },
    };
    assert.equal(
      seller[index - 1]!.record.requestDigest,
      await sessionBlockRequestDigest(request),
    );
    assert.deepEqual(buyer[index - 1]!.payment, seller[index - 1]!.payment);
    assert.equal(buyer[index - 1]!.observed.inputTokens, 2);
    assert.equal(buyer[index - 1]!.observed.outputTokens, 8);
    assert.equal(snapshot.reservedAtomic, '0');
  }
  assert.deepEqual(
    seller.map((row) => row.payment.amountAtomic),
    ['70', '70'],
  );
  assert.deepEqual(
    seller.map((row) => row.payment.feeAtomic),
    ['2', '3'],
  );
  assert.equal(f.offers.generations(), 2);
  assert.deepEqual(f.f.calls, ['deposit']);
});

void test('synchronous and asynchronous receipt failures preserve approved block answers without replay', async (t) => {
  let attempts = 0;
  const f = await blockProduct({
    receipts: () => ({
      engineKind: ENGINE_KINDS.OLLAMA,
      publisher: {
        publish() {
          throw new Error('Synthetic receipt unavailable');
        },
      },
    }),
    receipt: () => {
      if (++attempts === 1) throw new Error('Synthetic receipt unavailable');
      return Promise.reject(new Error('Synthetic receipt unavailable'));
    },
  });
  t.after(f.close);
  for (let index = 1; index <= 2; index++) {
    assert.equal(
      (
        await f.buyer.execute(
          await f.offers.quote(index),
          f.offers.input,
          new AbortController().signal,
        )
      ).text,
      'aa bb cc',
    );
  }
  assert.equal(attempts, 2);
  assert.equal(f.offers.generations(), 2);
  assert.deepEqual(f.f.calls, ['deposit']);
  assert.equal(f.f.buyer.snapshot().reservedAtomic, '0');
});

void test('interrupted block generation never fabricates a completed receipt or repeats the prompt', async (t) => {
  let receipts = 0;
  const f = await blockProduct({
    receipts: () => ({
      engineKind: ENGINE_KINDS.OLLAMA,
      publisher: {
        publish() {
          receipts++;
        },
      },
    }),
    receipt: () => {
      receipts++;
    },
  });
  t.after(f.close);
  f.offers.generate(async (input) => {
    await input.onText?.('aa ');
    throw new Error('Synthetic engine interrupted');
  });
  await assert.rejects(
    f.buyer.execute(
      await f.offers.quote(1),
      f.offers.input,
      new AbortController().signal,
    ),
  );
  assert.equal(receipts, 0);
  assert.equal(f.offers.generations(), 1);
});
