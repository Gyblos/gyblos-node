// No external network/RPC: actual Iroh, common generation and SDK/program settle only simulated token accounts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import {
  SESSION_CODES,
  SESSION_STATES,
} from '@gyblos/protocol/payment-session';

import { nativeBlockProduct } from '../support/batch-block-native';
import { BLOCK_TEXT } from '../support/batch-block-product';
import { within } from '../support/native-fixture';
import { NATIVE_TEST_OPTIONS } from '../support/native-runtime';

void test(
  'native blocks: two inferences share one deposit, verified signatures and one final settlement',
  NATIVE_TEST_OPTIONS,
  async (t) => {
    const now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    const f = await nativeBlockProduct(() => now);
    t.after(f.close);
    const sends = f.financial.vm.sends();
    for (const index of [1, 2]) {
      const chunks: string[] = [];
      const value = await within(
        f
          .buyer()
          .execute(
            await f.offers.quote(index),
            f.offers.input,
            undefined,
            async (text) => {
              chunks.push(text);
            },
          ),
      );
      assert.equal(value.text, BLOCK_TEXT);
      assert.deepEqual(chunks, ['aa ', 'bb ', 'cc']);
      assert.equal(f.financial.vm.sends(), sends + 1);
      assert.equal(f.financial.buyer.snapshot().reservedAtomic, '0');
    }
    assert.equal(f.offers.generations(), 2);
    assert.equal(f.financial.buyer.snapshot().cumulativeAtomic, '160');
    const closed = await within(f.buyer().close());
    assert.equal(closed.chargedAtomic, '160');
    assert.equal(closed.refundedAtomic, '840');
    assert.equal(
      await f.financial.vm.balance(f.financial.terms.buyer),
      f.financial.before.buyer - 160n,
    );
    assert.equal(f.financial.seller().snapshot().state, SESSION_STATES.CLOSED);
  },
);
void test(
  'native blocks: cancellation and seller restart recover the signed prefix without rerunning a prompt',
  NATIVE_TEST_OPTIONS,
  async (t) => {
    const now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    const f = await nativeBlockProduct(() => now);
    t.after(f.close);
    const controller = new AbortController();
    let received = 0;
    await assert.rejects(
      within(
        f
          .buyer()
          .execute(
            await f.offers.quote(1),
            f.offers.input,
            controller.signal,
            async () => {
              received++;
              controller.abort();
            },
          ),
      ),
      { code: PAID_EXECUTION_CODES.CANCELLED },
    );
    await f.restart();
    assert.equal(received, 1);
    assert.equal(f.offers.generations(), 1);
    assert.equal(await within(f.buyer().recoverApproval()), true);
    const settled = await f.buyer().reconcile();
    assert.equal(settled?.chargedAtomic, '32');
    assert.equal(settled?.refundedAtomic, '968');
    assert.equal(f.offers.generations(), 1);
    assert.equal(f.financial.buyer.snapshot().reservedAtomic, '0');
  },
);
void test(
  'native blocks: busy and unsupported prefix certification are refused before any deposit or generation',
  NATIVE_TEST_OPTIONS,
  async (t) => {
    const now = 1800000000000;
    t.mock.method(Date, 'now', () => now);
    const f = await nativeBlockProduct(() => now);
    t.after(f.close);
    const sends = f.financial.vm.sends();
    f.offers.busy(true);
    await assert.rejects(
      f.buyer().execute(await f.offers.quote(1), f.offers.input),
      { code: PAID_EXECUTION_CODES.BUSY },
    );
    f.offers.busy(false);
    delete f.offers.live.meter.stablePrefix;
    await assert.rejects(
      f.buyer().execute(await f.offers.quote(2), f.offers.input),
      { code: SESSION_CODES.UNAVAILABLE },
    );
    assert.equal(f.offers.generations(), 0);
    assert.equal(f.financial.vm.sends(), sends);
  },
);
