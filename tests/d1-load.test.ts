import assert from 'node:assert/strict';
import test from 'node:test';

import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';

import {
  D1_LOAD_LABELS,
  D1_MAX_BOUND_PARAMETERS,
  measureD1Load,
  type D1LoadLabel,
  type D1LoadRow,
} from './support/d1-load';
import { completedAggregation } from './support/d1-load-collector';

type D1LoadCap = Omit<D1LoadRow, 'label'>;

const cap = (
  statements: number,
  roundTrips: number,
  batches: number,
  maxParams: number,
  scans: number,
): D1LoadCap => ({ statements, roundTrips, batches, maxParams, scans });

const CAPS: Record<D1LoadLabel, D1LoadCap> = {
  [D1_LOAD_LABELS.PUBLISH_CATALOG_1]: cap(11, 3, 1, 18, 3),
  [D1_LOAD_LABELS.PUBLISH_CATALOG_64]: cap(11, 3, 1, 68, 3),
  [D1_LOAD_LABELS.READ_NETWORK]: cap(7, 7, 0, 5, 7),
  [D1_LOAD_LABELS.READ_MODELS]: cap(1, 1, 0, 5, 1),
  [D1_LOAD_LABELS.READ_OFFER_HISTORY]: cap(2, 2, 0, 4, 1),
  [D1_LOAD_LABELS.READ_NETWORK_HISTORY]: cap(3, 3, 0, 14, 0),
  [D1_LOAD_LABELS.CRON_ROLLUP]: cap(13, 13, 0, 14, 0),
  [D1_LOAD_LABELS.AGG_DAY_1]: cap(40, 9, 3, 6, 6),
  [D1_LOAD_LABELS.AGG_DAYS_31]: cap(760, 39, 33, 6, 66),
};

let measured: Promise<D1LoadRow[] | null> | undefined;
const load = () => (measured ??= measureD1Load());

void test('every measured D1 operation stays within its statement, round-trip, batch, bound-parameter and scan caps', async (context) => {
  const rows = await load();
  if (!rows) {
    context.skip('node:sqlite unavailable');
    return;
  }
  assert.deepEqual(
    rows.map((row) => row.label),
    Object.values(D1_LOAD_LABELS),
  );
  for (const row of rows) {
    const cap = CAPS[row.label];
    assert.ok(row.statements <= cap.statements, `${row.label} statements`);
    assert.ok(row.roundTrips <= cap.roundTrips, `${row.label} round trips`);
    assert.ok(row.batches <= cap.batches, `${row.label} batches`);
    assert.ok(row.scans <= cap.scans, `${row.label} scans`);
    assert.ok(row.maxParams <= cap.maxParams, `${row.label} bound parameters`);
    assert.ok(row.maxParams <= D1_MAX_BOUND_PARAMETERS, row.label);
  }
});

void test('a catalog publish with the most models a record allows writes in one batch', async (context) => {
  const rows = await load();
  if (!rows) {
    context.skip('node:sqlite unavailable');
    return;
  }
  const wide = rows.find(
    (row) => row.label === D1_LOAD_LABELS.PUBLISH_CATALOG_64,
  )!;
  assert.equal(PUBLIC_RECORD_LIMITS.maxModels, 64);
  assert.equal(wide.batches, 1);
  assert.ok(wide.maxParams <= D1_MAX_BOUND_PARAMETERS);
});

void test('an aggregation run that left a day failed, pending or unscanned is not measured', () => {
  const complete = {
    days: ['2026-11-16'],
    failed: [],
    more: false,
    scanFailed: false,
    chain: { days: [], failed: [], more: false, scanFailed: false },
  };
  assert.doesNotThrow(() => completedAggregation(complete, 1));
  for (const incomplete of [
    { ...complete, days: [] },
    { ...complete, failed: ['2026-11-16'] },
    { ...complete, more: true },
    { ...complete, scanFailed: true },
    { ...complete, chain: { ...complete.chain, failed: ['2026-11-16'] } },
    { ...complete, chain: { ...complete.chain, more: true } },
    { ...complete, chain: { ...complete.chain, scanFailed: true } },
  ])
    assert.throws(() => completedAggregation(incomplete, 1));
});
