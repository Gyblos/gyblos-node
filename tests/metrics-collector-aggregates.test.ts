// Protects the collector aggregates (#351): every formula against known raw rows, the source-time day
// rule, late data recomputing its day, disjoint demand, first-seen times, and a fixed statement
// budget per day whatever the number of raw rows.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { AGGREGATES } from '@gyblos/metrics-collector/constants';

import {
  DAY,
  DAY_START,
  HOUR,
  insertConflict,
  insertEnvelope,
  insertObservation,
  insertReceipt,
  NOW,
  SELLER_A,
  SELLER_B,
} from './support/metrics-collector-aggregates';
import { createCollectorD1 } from './support/metrics-collector-d1';

// node:sqlite rows have no prototype; copy them to compare deeply.
const rowsOf = (
  database: ReturnType<typeof createCollectorD1>,
  query: string,
) => database.rows(query).map((row) => ({ ...row }));
const buckets = (...samples: number[]) => {
  const counts = Array<number>(AGGREGATES.latencyBucketsMs.length + 1).fill(0);
  for (const sample of samples) {
    const index = AGGREGATES.latencyBucketsMs.findIndex(
      (edge) => sample < edge,
    );
    counts[index === -1 ? counts.length - 1 : index]! += 1;
  }
  return JSON.stringify(counts);
};

void test('network and seller totals follow the metric definitions', async () => {
  const database = createCollectorD1();
  insertReceipt(database, { firstTokenMs: 150, totalMs: 900 });
  insertReceipt(database, {
    status: 'seller-only',
    buyer: 'd4'.repeat(32),
    firstTokenMs: 50,
    totalMs: 3000,
    reasoningTokens: null,
  });
  // Disputed: counted apart and nowhere else.
  insertReceipt(database, { status: 'disputed', inputTokens: 999 });
  insertReceipt(database, { outcome: 'failed', totalMs: 70_000 });
  insertReceipt(database, {
    seller: SELLER_B,
    model: 'other/model',
    variant: 'q4',
  });
  const paidKey = insertReceipt(database, {
    paid: true,
    payer: 'Wallet1111',
    amountAtomic: '1000',
    feeAtomic: '40',
  });
  insertConflict(database, paidKey, NOW - HOUR);
  // A paid amount only the seller signed is counted as a request, never as authorized usage.
  insertReceipt(database, {
    paid: true,
    status: 'seller-only',
    amountAtomic: '500',
    feeAtomic: '20',
  });

  const result = await runAggregation(database, NOW);
  assert.deepEqual(result, {
    days: [DAY],
    failed: [],
    more: false,
    scanFailed: false,
    chain: { days: [], failed: [], more: false, scanFailed: false },
  });

  const [free, paid] = rowsOf(
    database,
    'SELECT * FROM collector_agg_network_daily ORDER BY paid',
  );
  assert.equal(free!.day, DAY);
  assert.deepEqual(
    [free!.bilateral, free!.seller_only, free!.disputed, free!.conflicts],
    [3, 1, 1, 0],
  );
  assert.deepEqual([free!.completed, free!.failed, free!.cancelled], [3, 1, 0]);
  // Headline tokens exclude the disputed receipt; unknown reasoning is counted, not zeroed.
  assert.deepEqual([free!.input_tokens, free!.reasoning_unknown], [40, 1]);
  assert.deepEqual(
    [free!.active_sellers, free!.buyers, free!.models_served],
    [2, 2, 2],
  );
  assert.equal(free!.first_token_hist, buckets(150, 50, 150, 150));
  // Total latency only for completed receipts.
  assert.equal(free!.total_hist, buckets(900, 3000, 900));
  assert.deepEqual(
    [
      paid!.seller_only,
      paid!.amount_atomic,
      paid!.fee_atomic,
      paid!.buyers,
      paid!.conflicts,
    ],
    [1, 1000, 40, 2, 1],
  );

  const sellers = rowsOf(
    database,
    'SELECT seller_node_id, model_id, variant, paid, completed FROM collector_agg_seller_daily ORDER BY seller_node_id, paid',
  );
  assert.deepEqual(
    sellers.map((row) => [
      row.seller_node_id,
      row.variant,
      row.paid,
      row.completed,
    ]),
    [
      [SELLER_A, '', 0, 2],
      [SELLER_A, '', 1, 2],
      [SELLER_B, 'q4', 0, 1],
    ],
  );
  const hours = rowsOf(
    database,
    'SELECT DISTINCT hour FROM collector_agg_seller_hourly',
  );
  assert.deepEqual(hours, [{ hour: (DAY_START + HOUR) / HOUR }]);
  const buyers = rowsOf(
    database,
    'SELECT seller_node_id, paid, buyers FROM collector_agg_seller_buyers_daily ORDER BY seller_node_id, paid',
  );
  assert.deepEqual(
    buyers.map((row) => [row.seller_node_id, row.paid, row.buyers]),
    [
      [SELLER_A, 0, 2],
      [SELLER_A, 1, 2],
      [SELLER_B, 0, 1],
    ],
  );
  for (const row of rowsOf(
    database,
    'SELECT * FROM collector_agg_network_daily',
  )) {
    assert.equal(row.formula_version, AGGREGATES.formulaVersion);
    assert.equal(row.aggregated_at, NOW);
  }
});

void test('items fall on their source day, and late data recomputes that day only', async () => {
  const database = createCollectorD1();
  insertReceipt(database, { receivedAt: DAY_START + HOUR });
  assert.deepEqual((await runAggregation(database, NOW)).days, [DAY]);
  // Nothing changed: nothing is recomputed.
  assert.deepEqual(
    (await runAggregation(database, NOW + 15 * 60_000 + 1)).days,
    [],
  );

  // Arrives the next day, for a request the seller received on DAY.
  const later = NOW + 2 * HOUR;
  insertReceipt(database, {
    receivedAt: DAY_START + 2 * HOUR,
    updatedAt: later,
  });
  assert.deepEqual((await runAggregation(database, later + 1)).days, [DAY]);
  const [row] = rowsOf(
    database,
    'SELECT bilateral, aggregated_at FROM collector_agg_network_daily',
  );
  assert.deepEqual([row!.bilateral, row!.aggregated_at], [2, later + 1]);
});

void test('observations give buyer latency, seller routes and disjoint unserved demand', async () => {
  const database = createCollectorD1();
  const at = DAY_START + 3 * HOUR;
  const buyer = insertEnvelope(database, 'buyer', at);
  const seller = insertEnvelope(database, 'seller', at);
  insertObservation(database, buyer, {
    type: 'first_token',
    at,
    firstTokenMs: 1200,
  });
  insertObservation(database, buyer, { type: 'completed', at, totalMs: 6500 });
  // A seller's first token is not buyer-experienced latency.
  insertObservation(database, seller, {
    type: 'first_token',
    at,
    firstTokenMs: 10,
  });
  insertObservation(database, seller, {
    type: 'completed',
    at,
    path: { route: 'iroh-direct' },
  });
  insertObservation(database, seller, {
    type: 'failed',
    at,
    path: { route: 'iroh-relay' },
  });
  insertObservation(database, seller, { type: 'completed', at });
  insertObservation(database, buyer, {
    type: 'unserved',
    at,
    model: 'wanted/model',
  });
  insertObservation(database, buyer, {
    type: 'refused',
    at,
    model: 'wanted/model',
    sellerNodeId: null,
    refusal: 'seller_busy',
  });
  insertObservation(database, buyer, {
    type: 'refused',
    at,
    model: 'wanted/model',
    sellerNodeId: null,
    refusal: 'connect_failed',
  });
  // A refusal by a chosen seller is not demand no seller served.
  insertObservation(database, buyer, {
    type: 'refused',
    at,
    model: 'wanted/model',
    sellerNodeId: SELLER_A,
    refusal: 'buyer_cap',
  });

  await runAggregation(database, NOW);
  const [observed] = rowsOf(
    database,
    'SELECT * FROM collector_agg_observed_daily',
  );
  assert.equal(observed!.buyer_first_token_hist, buckets(1200));
  assert.equal(observed!.buyer_total_hist, buckets(6500));
  assert.deepEqual(
    [observed!.route_direct, observed!.route_relay, observed!.route_unknown],
    [1, 1, 1],
  );
  assert.deepEqual(
    rowsOf(
      database,
      'SELECT model_id, unserved, refused_before_selection, connect_failed FROM collector_agg_demand_daily',
    ),
    [
      {
        model_id: 'wanted/model',
        unserved: 1,
        refused_before_selection: 1,
        connect_failed: 1,
      },
    ],
  );
});

void test('first-seen keeps the earliest time when an earlier day is recomputed', async () => {
  const database = createCollectorD1();
  insertReceipt(database, { receivedAt: DAY_START + 5 * HOUR });
  await runAggregation(database, NOW);
  const earlier = DAY_START - 20 * HOUR;
  insertReceipt(database, { receivedAt: earlier, updatedAt: NOW + HOUR });
  await runAggregation(database, NOW + HOUR + 1);
  const seller = rowsOf(
    database,
    "SELECT first_day, first_at FROM collector_first_seen WHERE kind = 'seller'",
  );
  assert.deepEqual(seller, [{ first_day: '2026-11-15', first_at: earlier }]);
  assert.deepEqual(
    database
      .rows('SELECT kind FROM collector_first_seen ORDER BY kind')
      .map((row) => row.kind),
    ['buyer-free', 'model', 'seller'],
  );
});

void test('a day costs a fixed set of statements whatever its rows, under the parameter limit', async () => {
  const statementsFor = async (receipts: number) => {
    const database = createCollectorD1();
    for (let index = 0; index < receipts; index++)
      insertReceipt(database, { buyer: index.toString(16).padStart(64, '0') });
    database.log.length = 0;
    await runAggregation(database, NOW);
    for (const entry of database.log) assert.ok(entry.params.length <= 100);
    return database.log.length;
  };
  assert.equal(await statementsFor(1), await statementsFor(60));
});

void test('a run recomputes at most maxDaysPerRun days, newest first, and leaves the rest dirty', async () => {
  const database = createCollectorD1();
  for (let day = 0; day <= AGGREGATES.maxDaysPerRun; day++)
    insertReceipt(database, { receivedAt: DAY_START - day * AGGREGATES.dayMs });
  const first = await runAggregation(database, NOW);
  assert.equal(first.days.length, AGGREGATES.maxDaysPerRun);
  assert.equal(first.days[0], DAY);
  assert.equal(first.more, true);
  const oldest = new Date(
    DAY_START - AGGREGATES.maxDaysPerRun * AGGREGATES.dayMs,
  )
    .toISOString()
    .split('T')[0]!;
  assert.deepEqual(await runAggregation(database, NOW + 1), {
    days: [oldest],
    failed: [],
    more: false,
    scanFailed: false,
    chain: { days: [], failed: [], more: false, scanFailed: false },
  });
});
