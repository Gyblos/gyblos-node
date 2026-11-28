import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  executeApiKeySession,
  reserveApiKey,
} from '@gyblos/buyer/api-key-execution';
import {
  createBuyerApiKeys,
  type BuyerApiKeyOperation,
} from '@gyblos/node/buyer-api-keys';
import {
  BATCH_METHODS,
  BatchChannelError,
} from '@gyblos/protocol/batch-channel';
import { BUYER_KEY_CHARGE } from '@gyblos/protocol/buyer-api-keys';
import {
  OPENING_STATUS,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { batchPrepareFixture } from './support/batch-prepare';

for (const expires of [false, true]) {
  void test(`pre-inference opening evidence releases only the delegated request when quote expires: ${expires}`, async (t) => {
    let first = true;
    let permission: BuyerApiKeyOperation | undefined;
    const f = await batchPrepareFixture(
      async () => {
        if (first && expires) f.rig.time(f.rig.now() + 30001);
        const absent = first && !expires;
        first = false;
        return absent ? OPENING_STATUS.ABSENT : OPENING_STATUS.PRESENT;
      },
      undefined,
      () => permission?.releaseUnsent,
    );
    t.after(f.close);
    const keys = await createBuyerApiKeys({
      files: { read: async () => undefined, write: async () => {} },
      scope: {
        payer: f.rig.terms.buyer,
        network: f.rig.terms.network,
        mint: f.rig.terms.mint,
      },
    });
    t.after(() => keys.close());
    const key = await keys.create('Synthetic agent', '1000');
    const run = async (index: number) => {
      const operation = keys.operation(key.id);
      permission = operation;
      const quote = await f.offers.quote(index);
      await reserveApiKey(operation, quote);
      return executeApiKeySession(operation, quote.offer.nodeId, async () => {
        const value = await f.buyer.execute(quote, f.offers.input);
        await operation.complete(
          f.rig.buyer.snapshot().cumulativeAtomic,
          BUYER_KEY_CHARGE.APPROVED,
        );
        return value;
      });
    };
    await assert.rejects(
      run(1),
      expires ? /EXPIRED/ : { code: SESSION_CODES.OPENING_ABSENT },
    );
    assert.equal(f.offers.generations(), 0);
    assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
    if (expires) {
      assert.equal((await run(2)).text, 'ok!');
      assert.equal(f.offers.generations(), 1);
      assert.deepEqual(f.rig.calls, ['deposit']);
    }
  });
}

for (const aborted of [false, true]) {
  void test(`the delegated reservation is released when opening observation is interrupted: ${aborted}`, async (t) => {
    const controller = new AbortController();
    let operation: BuyerApiKeyOperation | undefined;
    const f = await batchPrepareFixture(
      async () => {
        if (aborted) controller.abort();
        return OPENING_STATUS.ABSENT;
      },
      undefined,
      () => operation?.releaseUnsent,
    );
    t.after(f.close);
    if (!aborted)
      f.intercept(async (...args) => {
        if (args[0].method === BATCH_METHODS.OPEN)
          throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
        return f.service.exchange(...args);
      });
    const keys = await createBuyerApiKeys({
      files: { read: async () => undefined, write: async () => {} },
      scope: {
        payer: f.rig.terms.buyer,
        network: f.rig.terms.network,
        mint: f.rig.terms.mint,
      },
    });
    t.after(() => keys.close());
    const key = await keys.create('Synthetic cancellation', '1000');
    operation = keys.operation(key.id);
    const quote = await f.offers.quote(1);
    await reserveApiKey(operation, quote);
    await assert.rejects(
      executeApiKeySession(operation, quote.offer.nodeId, () =>
        f.buyer.execute(quote, f.offers.input, controller.signal),
      ),
    );
    for (let attempt = 0; attempt < 20 && operation.reserved(); attempt++)
      await delay(10);
    assert.equal((await keys.snapshot()).keys[0]?.reservedAtomic, '0');
    assert.equal(f.offers.generations(), 0);
    assert.deepEqual(f.rig.calls, aborted ? ['deposit'] : []);
  });
}
