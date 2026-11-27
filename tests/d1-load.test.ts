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

interface D1LoadCap {
  statements: number;
  roundTrips: number;
  batches: number;
  scans: number;
}

const cap = (
  statements: number,
  roundTrips: number,
  batches: number,
  scans: number,
): D1LoadCap => ({ statements, roundTrips, batches, scans });

const CAPS: Record<D1LoadLabel, D1LoadCap> = {
  [D1_LOAD_LABELS.PUBLISH_CATALOG_1]: cap(10, 2, 1, 3),
  [D1_LOAD_LABELS.PUBLISH_CATALOG_64]: cap(10, 2, 1, 3),
  [D1_LOAD_LABELS.READ_NETWORK]: cap(3, 3, 0, 3),
  [D1_LOAD_LABELS.READ_MODELS]: cap(1, 1, 0, 1),
  [D1_LOAD_LABELS.READ_OFFER_HISTORY]: cap(2, 2, 0, 1),
  [D1_LOAD_LABELS.READ_NETWORK_HISTORY]: cap(3, 3, 0, 0),
  [D1_LOAD_LABELS.CRON_ROLLUP]: cap(13, 13, 0, 0),
  [D1_LOAD_LABELS.AGG_DAY_1]: cap(39, 9, 3, 5),
  [D1_LOAD_LABELS.AGG_DAYS_31]: cap(759, 39, 33, 65),
};

let measured: Promise<D1LoadRow[] | null> | undefined;
const load = () => (measured ??= measureD1Load());

void test('every measured D1 operation stays within its statement, round-trip, batch and scan caps', async (context) => {
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
    assert.ok(
      row.maxParams <= D1_MAX_BOUND_PARAMETERS,
      `${row.label} bound parameters`,
    );
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
