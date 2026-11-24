import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseNetworkBuyers,
  type NetworkBuyers,
} from '@gyblos/explorer/collector-shape';
import { buyersText, newBuyersText } from '@gyblos/explorer/usage';
import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import {
  AGGREGATES,
  COLLECTOR_LIMITERS,
} from '@gyblos/metrics-collector/constants';
import { statsReader } from '@gyblos/metrics-collector/stats-read';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';

import { fakeLimiter } from './support/metrics-collector';
import {
  DAY,
  insertReceipt,
  NOW,
} from './support/metrics-collector-aggregates';
import { createCollectorD1 } from './support/metrics-collector-d1';

const hidden = { buyers: null, withheld: true };
const shown = (buyers: number) => ({ buyers, withheld: false });

void test('network buyers are checked at the boundary, and an older collector has none', () => {
  const buyers: NetworkBuyers = {
    free: { allTime: shown(1234), newInRange: shown(5) },
    paid: { allTime: hidden, newInRange: hidden },
  };
  assert.deepEqual(parseNetworkBuyers(buyers), buyers);
  assert.equal(parseNetworkBuyers(undefined), null);
  for (const broken of [
    { free: buyers.free },
    { ...buyers, paid: { allTime: hidden } },
    { ...buyers, free: { ...buyers.free, allTime: { buyers: '7' } } },
    { ...buyers, free: { ...buyers.free, allTime: { buyers: 7 } } },
    {
      ...buyers,
      free: { ...buyers.free, allTime: { buyers: 7, withheld: true } },
    },
    {
      ...buyers,
      paid: { ...buyers.paid, newInRange: { buyers: null, withheld: false } },
    },
  ])
    assert.throws(() => parseNetworkBuyers(broken), {
      name: 'SourceShapeError',
    });
});

void test('withheld buyer counts read as "< 5", never zero, and new buyers keep free and paid apart', () => {
  assert.equal(buyersText(hidden), `< ${AGGREGATES.minPublicBuyers}`);
  assert.equal(buyersText(shown(1234)), '1,234');
  assert.equal(
    newBuyersText(
      {
        free: { allTime: shown(9), newInRange: shown(6) },
        paid: { allTime: hidden, newInRange: hidden },
      },
      30,
    ),
    'New in the last 30 days: 6 free · < 5 paid',
  );
  assert.equal(newBuyersText(null, 7), undefined);
});

void test('the explorer reads the buyers the collector publishes', async () => {
  const database = createCollectorD1();
  for (let index = 0; index < AGGREGATES.minPublicBuyers; index++)
    insertReceipt(database, { buyer: index.toString(16).padStart(64, '0') });
  await runAggregation(database, NOW);
  const app = createMetricsCollector({
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
  const response = await app.request(
    `https://collector.test/v1/stats/network?from=${DAY}&to=${DAY}`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { buyerTotals: unknown };
  assert.deepEqual(parseNetworkBuyers(body.buyerTotals), {
    free: {
      allTime: shown(AGGREGATES.minPublicBuyers),
      newInRange: shown(AGGREGATES.minPublicBuyers),
    },
    paid: { allTime: hidden, newInRange: hidden },
  });
});
