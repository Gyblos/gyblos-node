import assert from 'node:assert/strict';
import test from 'node:test';

import { parseNetworkDay } from '@gyblos/explorer/collector-shape';
import { dailyRequests, summarizeUsage } from '@gyblos/explorer/usage';

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

void test('Usage cards report finalized empty receipt counts and leave unmeasured values unknown', () => {
  for (const state of ['final', 'pending', 'unknown']) {
    const usage = summarizeUsage({
      days: [parseNetworkDay(day('2026-11-17', { state }))],
    });
    const expected = state === 'final' ? 0 : null;
    for (const side of [usage.free, usage.paid]) {
      assert.equal(side.requests, expected);
      assert.equal(side.outputTokens, expected);
      assert.equal(side.successRate, null);
      assert.equal(side.firstToken, null);
    }
    assert.equal(usage.authorized, state === 'final' ? 0n : null);
  }
});
