// The pending-claim worker retries exactly the recorded charge on a bounded schedule with bounded
// attempts, stops on a lapse or a refusal it cannot fix, and leaves no timer behind. Synthetic server.
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
  const retry = createPaidRetry({
    payment,
    delaysMs: DELAYS,
    attemptMs: 1_000,
  });
  retry.queue(ADMISSION, '7');
  // The same claim queued again is not a second claim.
  retry.queue(ADMISSION, '7');
  await settledAll(retry);
  assert.deepEqual(charges, ['7', '7', '7']);
  assert.deepEqual(retry.health(), {
    queued: 0,
    settled: 1,
    lapsed: 0,
    failed: 0,
  });
  await retry.stop();
});

void test('a claim gives up after the schedule, on a lapse or on a refusal it cannot fix', async () => {
  for (const [outcomes, attempts, health] of [
    [
      [unavailable(), unavailable(), unavailable(), unavailable()],
      DELAYS.length + 1,
      { settled: 0, lapsed: 0, failed: 1 },
    ],
    [
      [new PaymentError(PAYMENT_ERROR_CODES.SETTLEMENT_LAPSED)],
      1,
      { settled: 0, lapsed: 1, failed: 0 },
    ],
    [
      [new PaymentError(PAYMENT_ERROR_CODES.INVALID_CHARGE)],
      1,
      { settled: 0, lapsed: 0, failed: 1 },
    ],
    [[new Error('bug')], 1, { settled: 0, lapsed: 0, failed: 1 }],
  ] as const) {
    const { payment, charges } = server([...outcomes]);
    const retry = createPaidRetry({
      payment,
      delaysMs: DELAYS,
      attemptMs: 1_000,
    });
    retry.queue(ADMISSION, '7');
    await settledAll(retry);
    assert.equal(charges.length, attempts);
    assert.deepEqual(retry.health(), { queued: 0, ...health });
    await retry.stop();
  }
});

void test('stopping cancels waiting retries and refuses new ones', async () => {
  const { payment, charges } = server([unavailable()]);
  const timers = () =>
    process.getActiveResourcesInfo().filter((name) => name === 'Timeout')
      .length;
  const before = timers();
  const retry = createPaidRetry({
    payment,
    delaysMs: [60_000],
    attemptMs: 1_000,
  });
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
  const retry = createPaidRetry({
    payment,
    delaysMs: [60_000],
    attemptMs: 1_000,
  });
  retry.queue(ADMISSION, '7');
  await new Promise((r) => setImmediate(r));
  await retry.stop();
  assert.equal(retry.health().queued, 0);
  // The hung attempt failing later starts no wait and no further attempt.
  const before = timers();
  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // The attempt's own deadline is cleared; no new timer appears.
  assert.ok(timers() <= before);
  assert.equal(attempts, 1);
});

void test('an attempt that never answers is retried, and a second charge for a queued channel is ignored', async () => {
  let calls = 0;
  const charges: string[] = [];
  const payment: PaymentServer = {
    describe: async () => {
      throw new Error('unused');
    },
    admit: async () => {
      throw new Error('unused');
    },
    settle(admission, chargedAtomic) {
      calls++;
      charges.push(chargedAtomic);
      if (calls === 1) return new Promise(() => {});
      return Promise.resolve({
        channelId: admission.channelId,
        chargedAtomic,
        refundedAtomic: '0',
        sellerAtomic: chargedAtomic,
        feeAtomic: '0',
        transaction: 't'.repeat(64),
      });
    },
  };
  const retry = createPaidRetry({ payment, delaysMs: [1], attemptMs: 10 });
  retry.queue(ADMISSION, '7');
  retry.queue(ADMISSION, '0');
  await settledAll(retry);
  assert.deepEqual(charges, ['7', '7']);
  assert.equal(retry.health().settled, 1);
  await retry.stop();
});
