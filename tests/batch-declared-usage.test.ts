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
import { createBuyerBatchSession } from '@gyblos/node/batch-buyer';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import { FREE_METERING } from '@gyblos/node/constants';
import { DECLARED_METER } from '@gyblos/node/free-meter';
import type { BuyerReceiptEvidence } from '@gyblos/node/receipts';
import { BATCH_CHANNEL, batchFail } from '@gyblos/protocol/batch-channel';
import {
  CONTROL_METERING_MODES,
  ENGINE_DONE_REASONS,
  ENGINE_KINDS,
} from '@gyblos/protocol/constants';
import type { InferenceOfferV2 } from '@gyblos/protocol/control-types';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import { SESSION_BLOCKS } from '@gyblos/protocol/session-blocks';

import {
  blockProduct,
  blockTestMeter,
  configureBlockEngine,
} from './support/batch-block-product';
import type { batchOfferFixture } from './support/batch-iroh-offer';
import { batchLoopback } from './support/batch-loopback';
import { multisellerLoopback } from './support/multiseller-session';

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

void test('a provider count above the byte bound is billed only up to it, and approved', async (t) => {
  const f = await blockProduct({
    offer: declaredSeller(90, 'ok'),
    declared: true,
  });
  t.after(f.close);
  await f.buyer.execute(await f.offers.quote(1, DECLARED), input(f.offers));
  const ceiling = 'ok'.length + FREE_METERING.declaredTemplateTokens;
  assert.equal(
    f.f.buyer.snapshot().cumulativeAtomic,
    String(chargeV2({ input: 7, output: ceiling }, PRICES)),
  );
});

void test('a provider count above maxTokens still delivers the answer, billed within the bounds', async (t) => {
  // The request allows 100 output tokens; the provider reports 110 for a two-byte answer.
  const f = await blockProduct({
    offer: declaredSeller(110, 'ok'),
    declared: true,
  });
  t.after(f.close);
  const value = await f.buyer.execute(
    await f.offers.quote(1, DECLARED),
    input(f.offers),
  );
  assert.equal(value.text, 'ok');
  const ceiling = 'ok'.length + FREE_METERING.declaredTemplateTokens;
  assert.equal(
    f.f.buyer.snapshot().cumulativeAtomic,
    String(chargeV2({ input: 7, output: ceiling }, PRICES)),
  );
});

void test('a declared sale follows a checkpointed one from the same seller on the same channel', async (t) => {
  // One seller lists recounted Qwen (sold with checkpoints) and a declared API model; the buyer keeps one
  // channel per seller, so the declared request must not be refused for the blocks the channel used.
  const f = await blockProduct({ perConnection: true });
  t.after(f.close);
  const recounted = await f.buyer.execute(
    await f.offers.quote(1),
    f.offers.input,
  );
  assert.equal(recounted.text.length > 0, true);
  const channelId = f.f.buyer.snapshot().channelId;
  const afterBlocks = BigInt(f.f.buyer.snapshot().cumulativeAtomic);
  declaredSeller(4)(f.offers);
  const value = await f.buyer.execute(
    await f.offers.quote(2, DECLARED),
    input(f.offers),
  );
  assert.equal(value.text, 'hola mundo');
  assert.equal(f.f.buyer.snapshot().channelId, channelId);
  assert.equal(
    BigInt(f.f.buyer.snapshot().cumulativeAtomic) - afterBlocks,
    chargeV2({ input: 7, output: 4 }, PRICES),
  );
  // And back to checkpoints on the same channel.
  configureBlockEngine(f.offers);
  f.offers.live.meteringMode = CONTROL_METERING_MODES.RECOUNTED;
  await f.buyer.execute(await f.offers.quote(3), f.offers.input);
  assert.equal(f.f.buyer.snapshot().channelId, channelId);
});

void test('a declared approval lost on a checkpointing channel is recovered without replaying the prompt', async (t) => {
  const f = await blockProduct({ perConnection: true });
  t.after(f.close);
  await f.buyer.execute(await f.offers.quote(1), f.offers.input);
  const afterBlocks = BigInt(f.f.buyer.snapshot().cumulativeAtomic);
  declaredSeller(4)(f.offers);
  const original = f.service.exchange.bind(f.service);
  let lost = true;
  t.mock.method(
    f.service,
    'exchange',
    async (...args: Parameters<typeof original>) => {
      const reply = await original(...args);
      if (lost && args[0].method === 'approve') {
        lost = false;
        batchFail(SESSION_CODES.UNAVAILABLE);
      }
      return reply;
    },
  );
  await assert.rejects(
    f.buyer.execute(await f.offers.quote(2, DECLARED), input(f.offers)),
    { code: SESSION_CODES.UNAVAILABLE },
  );
  const generated = f.offers.generations();
  assert.equal(await f.buyer.recoverApproval(), true);
  assert.equal(f.offers.generations(), generated);
  const charged = chargeV2({ input: 7, output: 4 }, PRICES);
  assert.equal(
    BigInt(f.f.buyer.snapshot().cumulativeAtomic) - afterBlocks,
    charged,
  );
  assert.equal(
    BigInt(f.f.seller().snapshot().cumulativeAtomic) - afterBlocks,
    charged,
  );
});

void test('a restored checkpointing channel keeps checkpoints when its first new request is declared', async (t) => {
  // After a restart the host is rebuilt from the first new quote; the channel's saved mode must win.
  const f = await blockProduct({ perConnection: true });
  t.after(f.close);
  await f.buyer.execute(await f.offers.quote(1), f.offers.input);
  await f.buyer.disconnect();
  await f.buyer.settled();
  const restored = createBuyerBatchSession({
    ...f.wire,
    terms: f.f.terms,
    buyer: f.f.buyer,
    meter: blockTestMeter,
    now: f.f.now,
    unresolved: async () => false,
    verify: async () => {},
    observe: f.f.sellerOptions.observe,
    declared: true,
  });
  t.after(async () => {
    await restored.disconnect();
    await restored.settled();
  });
  declaredSeller(4)(f.offers);
  await restored.execute(await f.offers.quote(2, DECLARED), input(f.offers));
  configureBlockEngine(f.offers);
  f.offers.live.meteringMode = CONTROL_METERING_MODES.RECOUNTED;
  const blocks = t.mock.method(f.f.buyer, 'beginBlocks');
  await restored.execute(await f.offers.quote(3), f.offers.input);
  assert.equal(blocks.mock.callCount(), 1);
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

for (const metering of [
  CONTROL_METERING_MODES.RECOUNTED,
  CONTROL_METERING_MODES.DECLARED,
])
  void test(`a new ${metering} channel prepares ${metering === CONTROL_METERING_MODES.DECLARED ? 'without' : 'with'} blocks for a buyer that supports them`, async (t) => {
    const fixture = await multisellerLoopback('10000');
    t.after(() => fixture.close());
    const alpns: string[] = [];
    const wire = await batchLoopback(
      {
        async exchange() {
          return batchFail(PAID_EXECUTION_CODES.PEER);
        },
      },
      fixture.a.terms,
    );
    t.after(() => wire.close());
    const connect = wire.endpoint.connect.bind(wire.endpoint);
    wire.endpoint.connect = async (...args: Parameters<typeof connect>) => {
      alpns.push(Buffer.from(args[1]).toString());
      return connect(...args);
    };
    const buyer = createBuyerSessionPool({
      ...fixture.options,
      meter: {
        ...fixture.options.meter,
        stablePrefix: blockTestMeter.stablePrefix,
      },
      openingSupportsBlocks: true,
      endpoint: wire.endpoint,
      destination: () => wire.destination,
    });
    t.after(() => buyer.close());
    const offer = fixture.offers[0]!;
    await assert.rejects(
      buyer.execute(
        await offer.quote(1, { meteringMode: metering }),
        offer.input,
        AbortSignal.timeout(3000),
      ),
    );
    assert.deepEqual(alpns, [
      metering === CONTROL_METERING_MODES.DECLARED
        ? BATCH_CHANNEL.alpn
        : SESSION_BLOCKS.alpn,
    ]);
  });
