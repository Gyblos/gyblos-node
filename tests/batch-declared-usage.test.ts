// A paid offer whose engine declares usage (no public tokenizer pinned for its model) can be sold. The
// buyer cannot recount it, so it accepts the declared bill only within what the bytes allow: no token holds
// less than one UTF-8 byte (ceiling) and none more than the declared maximum (floor). Synthetic engine.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chargeV2 } from '@gyblos/core/pricing-v2';
import {
  buildPaidSellerReceipt,
  type PaidSellerReceiptInput,
} from '@gyblos/core/receipts';
import { DECLARED_METER } from '@gyblos/node/free-meter';
import type { BuyerReceiptEvidence } from '@gyblos/node/receipts';
import {
  CONTROL_METERING_MODES,
  ENGINE_DONE_REASONS,
  ENGINE_KINDS,
} from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { blockProduct } from './support/batch-block-product';
import type { batchOfferFixture } from './support/batch-iroh-offer';

const PRICES = {
  inputAtomicPerMtok: '1000000',
  outputAtomicPerMtok: '1000000',
};
const DECLARED: Partial<InferenceOfferV2> = {
  meteringMode: CONTROL_METERING_MODES.DECLARED,
  prices: PRICES,
  maxTokens: 100,
};

function declaredSeller(outputTokens: number, text = 'hola mundo') {
  return (offers: Awaited<ReturnType<typeof batchOfferFixture>>) => {
    offers.live.meter = DECLARED_METER;
    offers.live.meteringMode = CONTROL_METERING_MODES.DECLARED;
    offers.live.offer = {
      ...offers.live.offer,
      prices: PRICES,
    } as typeof offers.live.offer;
    offers.generate(async (input) => {
      await input.onText?.(text);
      return {
        text,
        finishReason: ENGINE_DONE_REASONS.STOP,
        usage: {
          inputTokens: 7,
          outputTokens,
          totalDurationNs: 0,
          loadDurationNs: 0,
          inputDurationNs: 0,
          outputDurationNs: 0,
        },
      };
    });
  };
}
const input = (offers: { input: { messages: unknown[] } }) =>
  ({
    ...offers.input,
    maxTokens: 100,
  }) as never;

void test('a declared paid offer bills the provider-reported usage, even for a buyer set up for blocks', async (t) => {
  const f = await blockProduct({ offer: declaredSeller(4), declared: true });
  t.after(f.close);
  const value = await f.buyer.execute(
    await f.offers.quote(1, DECLARED),
    input(f.offers),
  );
  assert.equal(value.text, 'hola mundo');
  assert.equal(
    f.f.buyer.snapshot().cumulativeAtomic,
    String(chargeV2({ input: 7, output: 4 }, PRICES)),
  );
});

void test('a seller declaring more output tokens than the text has bytes is refused and not paid', async (t) => {
  const f = await blockProduct({
    offer: declaredSeller(90, 'ok'),
    declared: true,
  });
  t.after(f.close);
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(1, DECLARED), input(f.offers)),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(f.offers.generations(), 1, 'the seller generated');
  assert.equal(f.f.buyer.snapshot().cumulativeAtomic, '0', 'nothing approved');
});

void test('a recounted offer still requires the buyer recount', async (t) => {
  const f = await blockProduct();
  t.after(f.close);
  const value = await f.buyer.execute(await f.offers.quote(1), f.offers.input);
  assert.equal(value.text.length > 0, true);
});

void test('a declared paid request is attested by both halves, marked declared', async (t) => {
  const seller: PaidSellerReceiptInput[] = [];
  const buyer: BuyerReceiptEvidence[] = [];
  const f = await blockProduct({
    offer: declaredSeller(4),
    declared: true,
    receipts: () => ({
      engineKind: ENGINE_KINDS.OPENAI,
      publisher: {
        publish: (value) => {
          seller.push(value);
        },
      },
    }),
    receipt: (value) => {
      buyer.push(value);
    },
  });
  t.after(f.close);
  await f.buyer.execute(await f.offers.quote(1, DECLARED), input(f.offers));
  assert.equal(seller.length, 1);
  assert.equal(buyer.length, 1);
  const record = buildPaidSellerReceipt(seller[0]);
  assert.equal(record.metering, CONTROL_METERING_MODES.DECLARED);
  assert.deepEqual(buyer[0]!.payment, seller[0]!.payment);
});
