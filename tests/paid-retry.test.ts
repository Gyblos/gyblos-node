// The pending-claim worker retries exactly the recorded charge on a bounded schedule, stops on a lapse
// or a refusal retrying cannot fix, and leaves no timer behind. Synthetic payment server, short delays.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPaidRetry } from '@gyblos/node/paid-retry';
import { PAYMENT_ERROR_CODES } from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentServer,
} from '@gyblos/protocol/payment';

const ADMISSION: PaymentAdmission = {
  channelId: 'c'.repeat(64),
  payer: 'payer',
  requestDigest: 'ab'.repeat(32),
  maxAtomic: '20',
};
const DELAYS = [5, 5, 5] as const;

function server(outcomes: unknown[]) {
  const charges: string[] = [];
  const payment: PaymentServer = {
    describe: async () => {
      throw new Error('unused');
    },
    admit: async () => {
      throw new Error('unused');
    },
    async settle(admission, chargedAtomic) {
      charges.push(chargedAtomic);
      const outcome = outcomes.shift();
      if (outcome) throw outcome;
      return {
        channelId: admission.channelId,
        chargedAtomic,
        refundedAtomic: '0',
        sellerAtomic: chargedAtomic,
        feeAtomic: '0',
        transaction: 't'.repeat(64),
      };
    },
  };
  return { payment, charges };
}

const unavailable = () => new PaymentError(PAYMENT_ERROR_CODES.UNAVAILABLE);
const settledAll = (retry: ReturnType<typeof createPaidRetry>) =>
  new Promise<void>((resolve) => {
    const check = () =>
      retry.health().queued === 0 ? resolve() : setTimeout(check, 1);
    check();
  });

void test('a pending claim is retried with the same charge until it settles', async () => {
  const { payment, charges } = server([unavailable(), unavailable()]);
  const retry = createPaidRetry({ payment, delaysMs: DELAYS });
  retry.queue(ADMISSION, '7');
  // The same claim queued again is not a second claim.
  retry.queue(ADMISSION, '7');
  await settledAll(retry);
  assert.deepEqual(charges, ['7', '7', '7']);
  assert.deepEqual(retry.health(), { queued: 0, settled: 1, failed: 0 });
  await retry.stop();
});

void test('a claim gives up after the schedule, on a lapse or on a refusal it cannot fix', async () => {
  for (const [outcomes, settled, failed] of [
    [[unavailable(), unavailable(), unavailable(), unavailable()], 0, 1],
    [[new PaymentError(PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED)], 0, 0],
    [[new PaymentError(PAYMENT_ERROR_CODES.INVALID_CHARGE)], 0, 1],
  ] as const) {
    const { payment, charges } = server([...outcomes]);
    const retry = createPaidRetry({ payment, delaysMs: DELAYS });
    retry.queue(ADMISSION, '7');
    await settledAll(retry);
    assert.ok(charges.length <= DELAYS.length + 1);
    assert.deepEqual(retry.health(), { queued: 0, settled, failed });
    await retry.stop();
  }
});

void test('stopping cancels waiting retries and refuses new ones', async () => {
  const { payment, charges } = server([unavailable()]);
  const timers = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
      .length;
  const before = timers();
  const retry = createPaidRetry({ payment, delaysMs: [60_000] });
  retry.queue(ADMISSION, '7');
  while (charges.length === 0) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(timers(), before + 1);
  await retry.stop();
  // The waiting retry's timer is gone, so nothing keeps the process alive.
  assert.equal(timers(), before);
  retry.queue({ ...ADMISSION, channelId: 'd'.repeat(64) }, '1');
  assert.deepEqual(charges, ['7']);
  assert.equal(retry.health().queued, 0);
});

void test('stopping never waits for a hung attempt and starts no new wait', async () => {
  let release = () => {};
  let attempts = 0;
  const payment: PaymentServer = {
    describe: async () => {
      throw new Error('unused');
    },
    admit: async () => {
      throw new Error('unused');
    },
    settle: () => {
      attempts++;
      return new Promise((_resolve, reject) => {
        release = () => reject(unavailable());
      });
    },
  };
  const timers = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
      .length;
  const retry = createPaidRetry({ payment, delaysMs: [60_000] });
  retry.queue(ADMISSION, '7');
  await new Promise((r) => setImmediate(r));
  await retry.stop();
  assert.equal(retry.health().queued, 0);
  // The hung attempt failing later starts no wait and no further attempt.
  const before = timers();
  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(timers(), before);
  assert.equal(attempts, 1);
});
