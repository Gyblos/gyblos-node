// Protects how aggregate runs hold up (#351): a failing day never blocks the others, hostile raw values
// never stop a run, a formula change recomputes history, the statement budget is fixed, hourly rows
// are replaced on recompute, and histogram bounds are exact.
import assert from 'node:assert/strict';
import test from 'node:test';

import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { AGGREGATES } from '@gyblos/metrics-collector/constants';

import {
  DAY,
  DAY_START,
  HOUR,
  insertReceipt,
  NOW,
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

void test('a day that fails stays dirty and never blocks the other days', async () => {
  const database = createCollectorD1();
  insertReceipt(database, { receivedAt: DAY_START + HOUR });
  insertReceipt(database, { receivedAt: DAY_START - AGGREGATES.dayMs });
  const batch = database.batch.bind(database);
  let batches = 0;
  // The scan is the first batch; the newest day's batch (the second) fails once.
  database.batch = (statements) =>
    ++batches === 2
      ? Promise.reject(new Error('D1 unavailable'))
      : batch(statements);
  const run = await runAggregation(database, NOW);
  assert.deepEqual(run, { days: ['2026-11-15'], failed: [DAY], more: false });
  assert.deepEqual(
    rowsOf(database, 'SELECT day FROM collector_agg_dirty_days'),
    [{ day: DAY }],
  );
  assert.deepEqual((await runAggregation(database, NOW + 1)).days, [DAY]);
});

void test('raw values past year 9999 or beyond 64-bit sums never stop aggregation', async () => {
  const database = createCollectorD1();
  // Rows the ingest bounds refuse today, written straight to storage.
  insertReceipt(database, { receivedAt: Number.MAX_SAFE_INTEGER });
  for (let index = 0; index < 2; index++)
    insertReceipt(database, {
      paid: true,
      amountAtomic: '18446744073709551615',
      inputTokens: Number.MAX_SAFE_INTEGER,
    });
  const run = await runAggregation(database, NOW);
  assert.deepEqual(run, { days: [DAY], failed: [], more: false });
  assert.equal(
    rowsOf(database, 'SELECT count(*) AS n FROM collector_agg_dirty_days')[0]!
      .n,
    0,
  );
});

void test('a formula version change recomputes every day aggregated with another version', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  await runAggregation(database, NOW);
  // As after deploying a new formula: rows and the cursor carry the old version.
  database.raw.exec(
    'UPDATE collector_agg_seller_daily SET formula_version = 0; UPDATE collector_agg_state SET formula_version = 0',
  );
  const later = NOW + AGGREGATES.scanOverlapMs * 4;
  assert.deepEqual((await runAggregation(database, later)).days, [DAY]);
  assert.deepEqual(
    rowsOf(
      database,
      'SELECT DISTINCT formula_version FROM collector_agg_seller_daily',
    ),
    [{ formula_version: AGGREGATES.formulaVersion }],
  );
});

void test('a run is two reads, one scan batch of 4 and 17 statements per day', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  database.log.length = 0;
  await runAggregation(database, NOW);
  const sizes = new Map<number, number>();
  for (const entry of database.log)
    sizes.set(entry.batch, (sizes.get(entry.batch) ?? 0) + 1);
  assert.deepEqual([...sizes.values()], [2, 4, 17]);
});

void test('hourly rows hold their hour and are replaced when the day is recomputed', async () => {
  const database = createCollectorD1();
  insertReceipt(database, { receivedAt: DAY_START + HOUR });
  await runAggregation(database, NOW);
  insertReceipt(database, {
    receivedAt: DAY_START + 3 * HOUR,
    updatedAt: NOW + HOUR,
  });
  insertReceipt(database, {
    receivedAt: DAY_START + HOUR + 1,
    updatedAt: NOW + HOUR,
  });
  await runAggregation(database, NOW + HOUR + 1);
  assert.deepEqual(
    rowsOf(
      database,
      'SELECT hour, completed FROM collector_agg_seller_hourly ORDER BY hour',
    ),
    [
      { hour: (DAY_START + HOUR) / HOUR, completed: 2 },
      { hour: (DAY_START + 3 * HOUR) / HOUR, completed: 1 },
    ],
  );
});

void test('a latency on a bucket bound falls in the next bucket', async () => {
  const database = createCollectorD1();
  insertReceipt(database, { firstTokenMs: 100, totalMs: 60_000 });
  await runAggregation(database, NOW);
  const [row] = rowsOf(
    database,
    'SELECT first_token_hist, total_hist FROM collector_agg_network_daily',
  );
  assert.equal(row!.first_token_hist, buckets(100));
  assert.equal(JSON.parse(String(row!.first_token_hist))[1], 1);
  assert.equal(JSON.parse(String(row!.total_hist)).at(-1), 1);
});
