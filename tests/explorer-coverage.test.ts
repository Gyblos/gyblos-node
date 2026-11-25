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

void test('a network day keeps its coverage state, or null from an older collector', () => {
  assert.equal(
    parseNetworkDay(
      day('2026-11-17', { state: 'pending', cutoff: null, revision: null }),
    ).coverage,
    'pending',
  );
  assert.equal(parseNetworkDay(day('2026-11-17')).coverage, null);
  assert.throws(() => parseNetworkDay(day('2026-11-17', { state: 'later' })));
});

void test('daily series tell pending and uncaptured days apart from zero', () => {
  const series = dailyRequests(
    [
      day('2026-11-15', { state: 'unknown' }),
      day('2026-11-16', { state: 'pending' }),
      day('2026-11-17', { state: 'final' }),
    ].map(parseNetworkDay),
  );
  assert.deepEqual(series, [
    { day: '2026-11-15', free: 0, paid: 0, note: 'not captured' },
    { day: '2026-11-16', free: 0, paid: 0, note: 'pending' },
    { day: '2026-11-17', free: 0, paid: 0 },
  ]);
});
