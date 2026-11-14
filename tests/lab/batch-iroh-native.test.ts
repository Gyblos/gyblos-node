// Full session exchange over native Iroh and the SDK/program in LiteSVM; no external RPC or payments.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Endpoint } from '@number0/iroh';

import { TRANSPORT_LIMITS } from '@gyblos/config';
import { createBuyerBatchSession } from '@gyblos/node/batch-buyer';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import { serveSellerTransport } from '@gyblos/node/seller-transport';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_STATES } from '@gyblos/protocol/payment-session';

import { batchDeferred } from '../support/batch-deferred';
import { batchOfferFixture } from '../support/batch-iroh-offer';
import { batchNativeFinancial } from '../support/batch-native';
import { nativeBatchFinish } from '../support/native-batch-finish';
import { endpoint, within } from '../support/native-fixture';
import { NATIVE_CAPABILITY, waitFor } from '../support/native-runtime';

async function fixture(
  now: () => number,
  observeSeller?: (seller: Endpoint) => void,
) {
  let sellerEndpoint = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
  observeSeller?.(sellerEndpoint);
  const sellerSecret = [...sellerEndpoint.secretKey().toBytes()];
  const buyerEndpoint = await endpoint(undefined, [BATCH_CHANNEL.alpn]);
  const financial = await batchNativeFinancial(now, {
    buyerNodeId: buyerEndpoint.id().toString(),
    sellerNodeId: sellerEndpoint.id().toString(),
  });
  const offers = await batchOfferFixture(financial.terms, financial.owner, now);
  const serve = () =>
    serveSellerTransport(
      sellerEndpoint,
      {
        free: undefined,
        batchSessions: createSellerBatchSession({
          session: financial.seller(),
          terms: financial.terms,
          now,
          offers: () => [offers.live],
        }),
      },
      {
        relayOnly: false,
        limits: { transport: TRANSPORT_LIMITS, maxFreeBuyers: 1 },
      },
    );
  let server = serve();
  const connect = () =>
    createBuyerBatchSession({
      terms: financial.terms,
      buyer: financial.buyer,
      endpoint: buyerEndpoint,
      destination: sellerEndpoint.addr(),
      meter: offers.meter,
      now,
      unresolved: async () => false,
      verify: async (quote) => {
        assert.equal(quote.offer.owner, financial.terms.owner);
        assert.equal(quote.offer.nodeId, sellerEndpoint.id().toString());
      },
      observe: financial.observe,
    });
  let buyer = connect();
  return {
    financial,
    offers,
    buyer: () => buyer,
    async restart() {
      await buyer.disconnect();
      await buyer.settled();
      await server.close();
      await financial.restart();
      sellerEndpoint = await endpoint(sellerSecret, [BATCH_CHANNEL.alpn]);
      server = serve();
      buyer = connect();
    },
    async close() {
      await buyer.disconnect();
      await buyer.settled();
      await buyerEndpoint.close();
      await server.close();
      await financial.dispose();
    },
  };
}
void test(
  'native batch approval waits for the prior real FIN continuation without closing or repeating execution',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    // PREPARE and OPEN precede EXECUTE. Hold its native FIN continuation, not the FIN itself.
    const gate = nativeBatchFinish(3);
    const f = await fixture(() => now, gate.observeSeller);
    const sends = f.financial.vm.sends();
    const execution = (async () =>
      f.buyer().execute(await f.offers.quote(1), f.offers.input))();
    void execution.catch(() => undefined);
    try {
      await within(gate.finished);
      await within(gate.following);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        gate.closed(),
        false,
        'The next approval must not close the connection.',
      );
      assert.equal(f.offers.generations(), 1);
      assert.equal(f.financial.seller().snapshot().cumulativeAtomic, '0');
      assert.equal(f.financial.vm.sends(), sends + 1);
      gate.release();
      assert.equal((await within(execution)).text, 'ok!');
      assert.equal(f.financial.seller().snapshot().cumulativeAtomic, '40');
      assert.equal(await f.financial.buyer.recoverApproval(), undefined);
      assert.equal(f.offers.generations(), 1);
      assert.equal(f.financial.vm.sends(), sends + 1);
    } finally {
      gate.release();
      try {
        await f.close();
      } finally {
        await execution.catch(() => undefined);
      }
    }
  },
);
void test(
  'native batch Iroh: three prompts share one deposit and seller finalizes while buyer is offline',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    let now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    const f = await fixture(() => now);
    t.after(f.close);
    const sends = f.financial.vm.sends();
    for (let index = 1; index <= 3; index++) {
      const result = await within(
        f.buyer().execute(await f.offers.quote(index), f.offers.input),
      );
      assert.equal(result.text, 'ok!');
      assert.equal(f.financial.vm.sends(), sends + 1);
      assert.equal(
        await f.financial.vm.balance(f.financial.terms.buyer),
        f.financial.before.buyer - 1000n,
      );
      assert.equal(
        await f.financial.vm.balance(f.financial.terms.payTo),
        f.financial.before.seller,
      );
    }
    assert.equal(f.offers.generations(), 3);
    await f.buyer().disconnect();
    await f.buyer().settled();
    now += 1001;
    await waitFor(
      () => f.financial.seller().snapshot().state === SESSION_STATES.CLOSED,
      5000,
      'autonomous seller finalization',
    );
    const settled = await f.financial.observe(
      f.financial.buyer.snapshot().channelId,
    );
    assert.equal(settled?.chargedAtomic, '120');
    assert.equal(settled.refundedAtomic, '880');
    assert.equal(
      await f.financial.vm.balance(f.financial.terms.buyer),
      f.financial.before.buyer - 120n,
    );
    assert.equal((await f.buyer().reconcile())?.chargedAtomic, '120');
  },
);
void test(
  'native batch Iroh: seller restart retains the channel and highest voucher without another deposit',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    let now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    const f = await fixture(() => now);
    t.after(f.close);
    const sends = f.financial.vm.sends();
    await within(f.buyer().execute(await f.offers.quote(1), f.offers.input));
    const channel = f.financial.buyer.snapshot().channelId;
    await f.restart();
    assert.equal((await f.buyer().status()).channelId, channel);
    assert.equal((await f.buyer().status()).cumulativeAtomic, '40');
    await within(f.buyer().execute(await f.offers.quote(2), f.offers.input));
    assert.equal(f.financial.vm.sends(), sends + 1);
    const settled = await within(f.buyer().close());
    assert.equal(settled.chargedAtomic, '80');
    assert.equal(settled.refundedAtomic, '920');
    assert.equal(f.offers.generations(), 2);
  },
);
void test(
  'native batch Iroh: cancellation stops generation, does not resend and refunds unsigned usage',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    let now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    const f = await fixture(() => now);
    t.after(f.close);
    const started = batchDeferred<void>();
    let aborted = false;
    f.offers.generate(async (input) => {
      started.resolve();
      return new Promise((_, reject) => {
        const cancel = () => {
          aborted = true;
          reject(new Error('Synthetic engine stopped'));
        };
        input.signal?.addEventListener('abort', cancel, { once: true });
        if (input.signal?.aborted) cancel();
      });
    });
    const controller = new AbortController();
    const run = f
      .buyer()
      .execute(await f.offers.quote(1), f.offers.input, controller.signal);
    const rejected = assert.rejects(run, {
      code: PAID_EXECUTION_CODES.CANCELLED,
    });
    await within(started.promise);
    controller.abort();
    await rejected;
    await f.buyer().settled();
    await waitFor(() => aborted, 3500, 'remote engine abort');
    // The engine abort precedes the durable zero-charge bill. Advance time only after financial finish.
    await waitFor(
      () => f.financial.seller().snapshot().reservedAtomic === '0',
      3500,
      'zero-charge bill persisted',
    );
    assert.equal(f.offers.generations(), 1);
    assert.equal(await f.financial.buyer.recoverApproval(), undefined);
    now += 1001;
    await waitFor(
      () => f.financial.seller().snapshot().state === SESSION_STATES.CLOSED,
      5000,
      'unsigned session refund',
    );
    const settled = await f.financial.observe(
      f.financial.buyer.snapshot().channelId,
    );
    assert.equal(settled?.chargedAtomic, '0');
    assert.equal(settled.refundedAtomic, '1000');
  },
);
