import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeApiKeySession,
  reserveApiKey,
} from '@gyblos/buyer/api-key-execution';
import { createBuyerApiKeys } from '@gyblos/node/buyer-api-keys';
import { BUYER_KEY_CHARGE } from '@gyblos/protocol/buyer-api-keys';
import {
  OPENING_STATUS,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import { batchPrepareFixture } from './support/batch-prepare';

for (const expires of [false, true]) {
  void test(`pre-inference opening evidence releases only the delegated request when quote expires: ${expires}`, async (t) => {
    let first = true;
    const f = await batchPrepareFixture(async () => {
      if (first && expires) f.rig.time(f.rig.now() + 30001);
      const absent = first && !expires;
      first = false;
      return absent ? OPENING_STATUS.ABSENT : OPENING_STATUS.PRESENT;
    });
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
