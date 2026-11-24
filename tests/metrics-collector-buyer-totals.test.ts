import assert from 'node:assert/strict';
import test from 'node:test';

import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import {
  AGGREGATES,
  COLLECTOR_LIMITERS,
} from '@gyblos/metrics-collector/constants';
import type { NetworkStats } from '@gyblos/metrics-collector/stats';
import { statsReader } from '@gyblos/metrics-collector/stats-read';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';

import { fakeLimiter } from './support/metrics-collector';
import {
  DAY,
  DAY_START,
  HOUR,
  insertReceipt,
  NOW,
} from './support/metrics-collector-aggregates';
import { createCollectorD1 } from './support/metrics-collector-d1';

const TODAY = new Date(NOW).toISOString().split('T')[0]!;

const PREVIOUS_DAY = new Date(DAY_START - AGGREGATES.dayMs)
  .toISOString()
  .split('T')[0]!;
const MIN = AGGREGATES.minPublicBuyers;

const buyer = (index: number) => index.toString(16).padStart(64, '0');
const shown = (buyers: number) => ({ buyers, withheld: false });
const hidden = { buyers: null, withheld: true };

function collector(database: ReturnType<typeof createCollectorD1>) {
  return createMetricsCollector({
    storage: createD1Storage(database),
    stats: statsReader(database),
    limiters: {
      [COLLECTOR_LIMITERS.IP]: fakeLimiter(),
      [COLLECTOR_LIMITERS.NODE]: fakeLimiter(),
      [COLLECTOR_LIMITERS.GLOBAL]: fakeLimiter(),
      [COLLECTOR_LIMITERS.READ]: fakeLimiter(),
    },
    now: () => NOW,
  });
}
async function totals(
  app: ReturnType<typeof collector>,
  from: string,
  to: string,
) {
  const response = await app.request(
    `https://collector.test/v1/stats/network?from=${from}&to=${to}`,
  );
  assert.equal(response.status, 200);
  return ((await response.json()) as NetworkStats).buyerTotals;
}

void test('buyer totals count all time and new in the range, free and paid apart', async () => {
  const database = createCollectorD1();
  const previous = DAY_START - AGGREGATES.dayMs + HOUR;
  for (let index = 0; index < MIN - 1; index++)
    insertReceipt(database, { buyer: buyer(index), receivedAt: previous });
  insertReceipt(database, { buyer: buyer(0) });
  for (let index = MIN; index < 2 * MIN; index++)
    insertReceipt(database, { buyer: buyer(index) });
  insertReceipt(database, { paid: true, payer: 'Wallet', buyer: buyer(0) });
  await runAggregation(database, NOW);
  const app = collector(database);

  assert.deepEqual(await totals(app, DAY, DAY), {
    free: { allTime: shown(2 * MIN - 1), newInRange: shown(MIN) },
    paid: { allTime: hidden, newInRange: hidden },
  });
  assert.deepEqual(await totals(app, PREVIOUS_DAY, DAY), {
    free: { allTime: shown(2 * MIN - 1), newInRange: shown(2 * MIN - 1) },
    paid: { allTime: hidden, newInRange: hidden },
  });
});

void test('buyer counts below the minimum are withheld, zero included', async () => {
  const database = createCollectorD1();
  for (let index = 0; index < MIN - 1; index++)
    insertReceipt(database, { buyer: buyer(index) });
  for (let index = 0; index < MIN; index++)
    insertReceipt(database, {
      paid: true,
      payer: `Wallet${index}`,
      buyer: buyer(100 + index),
    });
  await runAggregation(database, NOW);
  const app = collector(database);

  assert.deepEqual(await totals(app, DAY, DAY), {
    free: { allTime: hidden, newInRange: hidden },
    paid: { allTime: shown(MIN), newInRange: shown(MIN) },
  });
  assert.deepEqual(await totals(app, PREVIOUS_DAY, PREVIOUS_DAY), {
    free: { allTime: hidden, newInRange: hidden },
    paid: { allTime: shown(MIN), newInRange: hidden },
  });
  assert.deepEqual(await totals(collector(createCollectorD1()), DAY, DAY), {
    free: { allTime: hidden, newInRange: hidden },
    paid: { allTime: hidden, newInRange: hidden },
  });
});

void test('paid buyers are wallets and free buyers NodeIds, each counted once', async () => {
  const database = createCollectorD1();
  for (let index = 0; index < 2 * MIN; index++) {
    insertReceipt(database, {
      paid: true,
      payer: `Wallet${index % MIN}`,
      buyer: buyer(index),
    });
    insertReceipt(database, { buyer: buyer(index % MIN) });
  }
  await runAggregation(database, NOW);

  assert.deepEqual(await totals(collector(database), DAY, DAY), {
    free: { allTime: shown(MIN), newInRange: shown(MIN) },
    paid: { allTime: shown(MIN), newInRange: shown(MIN) },
  });
});

void test('buyers first seen today wait until the UTC day closes', async () => {
  const database = createCollectorD1();
  for (let index = 0; index < MIN; index++)
    insertReceipt(database, { buyer: buyer(index) });
  for (let index = MIN; index < 2 * MIN; index++)
    insertReceipt(database, { buyer: buyer(index), receivedAt: NOW - HOUR });
  await runAggregation(database, NOW);
  const app = collector(database);

  assert.deepEqual(await totals(app, DAY, TODAY), {
    free: { allTime: shown(MIN), newInRange: shown(MIN) },
    paid: { allTime: hidden, newInRange: hidden },
  });
  assert.deepEqual(await totals(app, TODAY, TODAY), {
    free: { allTime: shown(MIN), newInRange: hidden },
    paid: { allTime: hidden, newInRange: hidden },
  });
});
