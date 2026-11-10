// Delayed local hints cannot authorize a new opening after cancellation or host expiry.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { batchSessionPathsIn } from '@gyblos/config';
import { createBatchBuyer } from '@gyblos/payments-upto/batch-session';
import { SESSION_CODES, sessionFail } from '@gyblos/protocol/payment-session';

import { sessionRig } from './support/batch-session';

for (const expired of [false, true]) {
  void test(`opening never signs after delayed hints ${expired ? 'expire' : 'are cancelled'}`, async (t) => {
    const rig = await sessionRig();
    t.after(rig.dispose);
    let release: () => void = () => {};
    let ready: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signatures = 0;
    let cancelled = false;
    const buyer = await createBatchBuyer({
      ...rig.buyerOptions,
      paths: batchSessionPathsIn(
        { GYBLOS_HOME: join(rig.root, 'guarded') },
        'buyer',
      ),
      payer: {
        address: rig.buyerOptions.payer.address,
        signMessages: (...args) => {
          signatures++;
          return rig.buyerOptions.payer.signMessages(...args);
        },
        signTransactions: (...args) => {
          signatures++;
          return rig.buyerOptions.payer.signTransactions(...args);
        },
      },
      hints: async () => {
        ready();
        await pending;
        return rig.buyerOptions.hints();
      },
    });
    t.after(buyer.dispose);
    const result = buyer.open(() => {
      if (cancelled) return sessionFail(SESSION_CODES.UNAVAILABLE);
    });
    await started;
    if (expired) rig.time(rig.terms.expiresAt);
    else cancelled = true;
    release();
    await assert.rejects(result);
    assert.equal(signatures, 0);
  });
}
