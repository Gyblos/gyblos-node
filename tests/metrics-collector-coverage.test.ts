import assert from 'node:assert/strict';
import test from 'node:test';

import { runAggregation } from '@gyblos/metrics-collector/aggregate';
import { AGGREGATES } from '@gyblos/metrics-collector/constants';
import { networkStats } from '@gyblos/metrics-collector/stats';
import { statsReader } from '@gyblos/metrics-collector/stats-read';

import {
  DAY,
  DAY_START,
  HOUR,
  insertEnvelope,
  insertObservation,
  insertReceipt,
  NOW,
} from './support/metrics-collector-aggregates';
import { createCollectorD1 } from './support/metrics-collector-d1';

const dayAt = (offset: number) =>
  new Date(DAY_START + offset * AGGREGATES.dayMs).toISOString().slice(0, 10);
const TODAY = dayAt(1);

const coverageRows = (database: ReturnType<typeof createCollectorD1>) =>
  database
    .rows(
      'SELECT day, formula_version, cutoff, revision FROM collector_agg_days ORDER BY day',
    )
    .map((row) => ({ ...row }));

const stats = (
  database: ReturnType<typeof createCollectorD1>,
  from: string,
  to: string,
) => networkStats(statsReader(database), { from, to }, TODAY);

void test('a computed day records its coverage in the same batch', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  await runAggregation(database, NOW);
  assert.deepEqual(coverageRows(database), [
    {
      day: DAY,
      formula_version: AGGREGATES.formulaVersion,
      cutoff: NOW,
      revision: 1,
    },
  ]);
});

void test('days without rows since the capture start are closed', async () => {
  const database = createCollectorD1();
  insertReceipt(database, { receivedAt: DAY_START - 2 * AGGREGATES.dayMs });
  await runAggregation(database, NOW);
  await runAggregation(database, NOW + HOUR);
  assert.deepEqual(
    coverageRows(database).map((row) => row.day),
    [dayAt(-2), dayAt(-1), DAY],
  );
  const { days } = await stats(database, dayAt(-1), dayAt(-1));
  assert.equal(days[0]!.free, null);
  assert.equal(days[0]!.coverage.state, 'final');
});

void test('late data recomputes the day and raises its revision', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  await runAggregation(database, NOW);
  insertReceipt(database, { updatedAt: NOW + HOUR });
  await runAggregation(database, NOW + 2 * HOUR);
  const [row] = coverageRows(database);
  assert.equal(row!.revision, 2);
  assert.equal(row!.cutoff, NOW + 2 * HOUR);
});

void test('a failed day batch leaves no coverage behind', async () => {
  const database = createCollectorD1();
  insertReceipt(database);
  const batch = database.batch.bind(database);
  let batches = 0;
  database.batch = (statements) =>
    ++batches === 2
      ? Promise.reject(new Error('D1 unavailable'))
      : batch(statements);
  await runAggregation(database, NOW);
  assert.deepEqual(coverageRows(database), []);
});

void test('each day says whether it is final, partial, pending or unknown', async () => {
  const database = createCollectorD1();
  insertReceipt(database, { receivedAt: DAY_START - AGGREGATES.dayMs });
  insertReceipt(database);
  await runAggregation(database, NOW);
  database.raw
    .prepare('INSERT INTO collector_agg_dirty_days (day) VALUES (?)')
    .run(dayAt(-1));
  const answer = await stats(database, dayAt(-3), TODAY);
  assert.deepEqual(
    answer.days.map((day) => [day.day, day.coverage.state]),
    [
      [dayAt(-3), 'unknown'],
      [dayAt(-2), 'unknown'],
      [dayAt(-1), 'pending'],
      [DAY, 'final'],
      [TODAY, 'partial'],
    ],
  );
  assert.equal(answer.completeThrough, null);
  database.raw.prepare('DELETE FROM collector_agg_dirty_days').run();
  assert.equal((await stats(database, dayAt(-3), TODAY)).completeThrough, DAY);
  const final = answer.days[3]!.coverage;
  assert.equal(final.cutoff, NOW);
  assert.equal(final.revision, 1);
});

void test('demand totals count every model before the public cut', async () => {
  const database = createCollectorD1();
  const at = DAY_START + 3 * HOUR;
  const buyer = insertEnvelope(database, 'buyer', at);
  const models = AGGREGATES.maxPublicDemandPerDay + 5;
  for (let index = 0; index < models; index++)
    insertObservation(database, buyer, {
      type: 'unserved',
      at,
      model: `wanted/model-${index}`,
    });
  await runAggregation(database, NOW);
  const [day] = (await stats(database, DAY, DAY)).days;
  assert.equal(day!.demand.length, AGGREGATES.maxPublicDemandPerDay);
  assert.equal(day!.demandModels, models);
  assert.equal(day!.demandTotal, models);
});
