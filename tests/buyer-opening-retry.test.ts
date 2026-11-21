// A failed OPEN can be recovered without re-signing the deposit or replaying inference.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_METHODS,
  BatchChannelError,
} from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

import { batchPrepareFixture } from './support/batch-prepare';

for (const status of ['present', 'absent', 'unknown'] as const) {
  void test(`uncertain OPEN checks the original deposit: ${status}`, async (t) => {
    let observations = 0;
    const f = await batchPrepareFixture(async () => {
      observations++;
      return status;
    });
    t.after(f.close);
    const payloads: string[] = [];
    f.intercept(async (...args) => {
      const [request] = args;
      if (request.method === BATCH_METHODS.OPEN) {
        payloads.push(request.params.payload);
        if (payloads.length === 1) {
          if (status === 'present') await f.service.exchange(...args);
          throw new BatchChannelError(SESSION_CODES.UNAVAILABLE);
        }
      }
      return f.service.exchange(...args);
    });
    const run = f.buyer.execute(await f.offers.quote(1), f.offers.input);
    if (status === 'present') {
      assert.equal((await run).text, 'ok!');
      assert.deepEqual(payloads, [payloads[0], payloads[0]]);
      assert.equal(f.offers.generations(), 1);
      assert.deepEqual(f.rig.calls, ['deposit']);
    } else {
      await assert.rejects(run, {
        code:
          status === 'absent'
            ? 'PAYMENT_SESSION_OPENING_ABSENT'
            : 'PAYMENT_SESSION_OPENING_PENDING',
      });
      assert.equal(payloads.length, 1);
      assert.equal(f.offers.generations(), 0);
    }
    assert.ok(observations >= (status === 'unknown' ? 2 : 1));
  });
}
