import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNetworkDay } from '@gyblos/explorer/collector-shape';
import { dailyRequests } from '@gyblos/explorer/usage';

const day = (date: string, coverage?: unknown) => ({
  day: date,
  free: null,
  paid: null,
  observed: null,
  demand: [],
  ...(coverage === undefined ? {} : { coverage }),
});

void test('a network day keeps its coverage state, or null when absent or unknown', () => {
  assert.equal(
    parseNetworkDay(
      day('2026-11-17', { state: 'pending', cutoff: null, revision: null }),
    ).coverage,
    'pending',
  );
  assert.equal(parseNetworkDay(day('2026-11-17')).coverage, null);
  assert.equal(
    parseNetworkDay(day('2026-11-17', { state: 'later' })).coverage,
    null,
  );
});

void test('daily series tell pending and uncaptured days apart from zero', () => {
  const series = dailyRequests(
    [
      day('2026-11-15', { state: 'unknown' }),
      day('2026-11-16', { state: 'pending' }),
      day('2026-11-17', { state: 'final' }),
      day('2026-11-18', { state: 'partial' }),
    ].map(parseNetworkDay),
  );
  assert.deepEqual(series, [
    { day: '2026-11-15', free: null, paid: null, note: 'not captured' },
    { day: '2026-11-16', free: null, paid: null, note: 'pending' },
    { day: '2026-11-17', free: 0, paid: 0 },
    { day: '2026-11-18', free: null, paid: null, note: 'so far' },
  ]);
});
