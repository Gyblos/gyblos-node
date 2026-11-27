// Protects the network breakdowns (#351): requests by the buyer application that reported them
// (unknown when only the seller did), failures by side, application, event and reason (the stop
// reason, else the code, such as the context limit), and the public answer withholding any row with
// fewer than the minimum distinct buyers.
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
  insertEnvelope,
  insertObservation,
  insertReceipt,
  insertReport,
  NOW,
} from './support/metrics-collector-aggregates';
import { createCollectorD1 } from './support/metrics-collector-d1';

const AT = DAY_START + 2 * HOUR;
const buyerId = (index: number) => index.toString(16).padStart(64, '0');
const rows = (database: ReturnType<typeof createCollectorD1>, query: string) =>
  database.rows(query).map((row) => ({ ...row }));

void test('requests are split by the buyer application that reported them', async () => {
  const database = createCollectorD1();
  const desktop = insertEnvelope(database, 'buyer', AT, 'buyer-desktop');
  const cli = insertEnvelope(database, 'buyer', AT, 'buyer-cli');
  const seller = insertEnvelope(database, 'seller', AT);
  for (let index = 0; index < 6; index += 1) {
    const key = insertReceipt(database, {
      buyer: buyerId(index),
      outcome: index === 0 ? 'failed' : 'completed',
    });
    insertReport(database, seller, key, 'seller');
    insertReport(database, desktop, key, 'buyer');
  }
  insertReport(
    database,
    cli,
    insertReceipt(database, { buyer: buyerId(10) }),
    'buyer',
  );
  // Only the seller reported these: the buyer's application is unknown.
  for (const outcome of ['failed', 'cancelled'] as const)
    insertReport(
      database,
      seller,
      insertReceipt(database, {
        buyer: buyerId(20),
        status: 'seller-only',
        outcome,
      }),
      'seller',
    );
  // A disputed receipt is not a headline request.
  insertReceipt(database, { buyer: buyerId(30), status: 'disputed' });
  await runAggregation(database, NOW);
  assert.deepEqual(
    rows(
      database,
      'SELECT client_kind, paid, requests, completed, failed, cancelled, buyers FROM collector_agg_origin_daily ORDER BY client_kind',
    ),
    [
      {
        client_kind: 'buyer-cli',
        paid: 0,
        requests: 1,
        completed: 1,
        failed: 0,
        cancelled: 0,
        buyers: 1,
      },
      {
        client_kind: 'buyer-desktop',
        paid: 0,
        requests: 6,
        completed: 5,
        failed: 1,
        cancelled: 0,
        buyers: 6,
      },
      {
        client_kind: 'unknown',
        paid: 0,
        requests: 2,
        completed: 0,
        failed: 1,
        cancelled: 1,
        buyers: 1,
      },
    ],
  );
});

void test('paid origins count wallets, and a receipt from both applications counts once', async () => {
  const database = createCollectorD1();
  const desktop = insertEnvelope(database, 'buyer', AT, 'buyer-desktop');
  const cli = insertEnvelope(database, 'buyer', AT, 'buyer-cli');
  const both = insertReceipt(database, { buyer: buyerId(1) });
  insertReport(database, desktop, both, 'buyer');
  insertReport(database, cli, both, 'buyer');
  // Two paid receipts from one wallet through two buyer keys: one paid buyer.
  for (const buyer of [buyerId(2), buyerId(3)])
    insertReport(
      database,
      desktop,
      insertReceipt(database, { buyer, paid: true, payer: 'wallet-a' }),
      'buyer',
    );
  await runAggregation(database, NOW);
  assert.deepEqual(
    rows(
      database,
      'SELECT client_kind, paid, requests, buyers FROM collector_agg_origin_daily ORDER BY paid, client_kind',
    ),
    [
      { client_kind: 'buyer-cli', paid: 0, requests: 1, buyers: 1 },
      { client_kind: 'buyer-desktop', paid: 1, requests: 2, buyers: 1 },
    ],
  );
});

void test('failures are split by side, application, event and reason', async () => {
  const database = createCollectorD1();
  const seller = insertEnvelope(database, 'seller', AT);
  const cli = insertEnvelope(database, 'buyer', AT, 'buyer-cli');
  const failed = (buyerNodeId: string, extra: Record<string, unknown>) =>
    insertObservation(database, seller, {
      type: 'failed',
      at: AT,
      buyerNodeId,
      code: 'FREE_EXECUTION_SELLER_CANNOT_CONTINUE',
      ...extra,
    });
  failed(buyerId(1), { reason: 'engine_timeout' });
  failed(buyerId(2), { reason: 'engine_timeout' });
  // No stop reason: the code names it (here the context limit).
  failed(buyerId(1), { code: 'FREE_EXECUTION_LIMIT_EXCEEDED', reason: null });
  insertObservation(database, cli, {
    type: 'refused',
    at: AT,
    buyerNodeId: buyerId(3),
    refusal: 'seller_busy',
  });
  insertObservation(database, cli, {
    type: 'unserved',
    at: AT,
    buyerNodeId: buyerId(3),
  });
  // Completed work is not a failure.
  insertObservation(database, seller, { type: 'completed', at: AT });
  await runAggregation(database, NOW);
  assert.deepEqual(
    rows(
      database,
      'SELECT side, client_kind, event, reason, events, buyers FROM collector_agg_failures_daily ORDER BY side, event, reason',
    ),
    [
      {
        side: 'buyer',
        client_kind: 'buyer-cli',
        event: 'refused',
        reason: 'seller_busy',
        events: 1,
        buyers: 1,
      },
      {
        side: 'buyer',
        client_kind: 'buyer-cli',
        event: 'unserved',
        reason: 'none',
        events: 1,
        buyers: 1,
      },
      {
        side: 'seller',
        client_kind: 'seller-node',
        event: 'failed',
        reason: 'FREE_EXECUTION_LIMIT_EXCEEDED',
        events: 1,
        buyers: 1,
      },
      {
        side: 'seller',
        client_kind: 'seller-node',
        event: 'failed',
        reason: 'engine_timeout',
        events: 2,
        buyers: 2,
      },
    ],
  );
});

void test('the network answer withholds every breakdown row below the buyer minimum', async () => {
  const database = createCollectorD1();
  const desktop = insertEnvelope(database, 'buyer', AT, 'buyer-desktop');
  const seller = insertEnvelope(database, 'seller', AT);
  for (let index = 0; index < AGGREGATES.minPublicBuyers; index += 1) {
    insertReport(
      database,
      desktop,
      insertReceipt(database, { buyer: buyerId(index) }),
      'buyer',
    );
    insertObservation(database, seller, {
      type: 'failed',
      at: AT,
      buyerNodeId: buyerId(index),
      code: 'FREE_EXECUTION_TIMEOUT',
      reason: null,
    });
  }
  insertReceipt(database, { buyer: buyerId(99) });
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
  const [day] = ((await response.json()) as NetworkStats).days;
  assert.deepEqual(day!.origins, [
    {
      client: 'buyer-desktop',
      paid: false,
      buyers: AGGREGATES.minPublicBuyers,
      withheld: false,
      requests: AGGREGATES.minPublicBuyers,
      outcomes: {
        completed: AGGREGATES.minPublicBuyers,
        failed: 0,
        cancelled: 0,
      },
    },
    {
      client: 'unknown',
      paid: false,
      buyers: null,
      withheld: true,
      requests: null,
      outcomes: null,
    },
  ]);
  assert.deepEqual(day!.failures, [
    {
      side: 'seller',
      client: 'seller-node',
      event: 'failed',
      reason: 'FREE_EXECUTION_TIMEOUT',
      buyers: AGGREGATES.minPublicBuyers,
      withheld: false,
      events: AGGREGATES.minPublicBuyers,
    },
  ]);
});

void test('a buyer report arriving after aggregation re-marks the receipt day', async () => {
  const database = createCollectorD1();
  const key = insertReceipt(database, { status: 'seller-only' });
  const seller = insertEnvelope(database, 'seller', AT);
  insertReport(database, seller, key, 'seller');
  await runAggregation(database, NOW);
  assert.deepEqual(
    rows(database, 'SELECT client_kind FROM collector_agg_origin_daily'),
    [{ client_kind: 'unknown' }],
  );
  const buyer = insertEnvelope(database, 'buyer', NOW + 1);
  insertReport(database, buyer, key, 'buyer', NOW + 1);
  await runAggregation(database, NOW + 2);
  assert.deepEqual(
    rows(database, 'SELECT client_kind FROM collector_agg_origin_daily'),
    [{ client_kind: 'buyer-desktop' }],
  );
});
