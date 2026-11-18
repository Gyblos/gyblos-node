// Protects the explorer's display choices: the date range accepts only its presets and maps to the
// collector's inclusive UTC days; a model's mark comes from its id's family name, never a guess; the
// daily series keep every day of the range, empty ones as zero.
import assert from 'node:assert/strict';
import test from 'node:test';

import { dailySettled } from '@gyblos/explorer/chain-shape';
import { modelFamily } from '@gyblos/explorer/model-family';
import { parseRange, rangeQuery } from '@gyblos/explorer/range';
import { dailyRequests } from '@gyblos/explorer/usage';

void test('the range is a preset or the 30-day default', () => {
  assert.equal(parseRange('7'), 7);
  assert.equal(parseRange('90'), 90);
  for (const value of [undefined, '', '8', '365', ['7'], '7d', 7])
    assert.equal(parseRange(value), 30);
});

void test('a range maps to the collector days ending today, inclusive', () => {
  const now = Date.parse('2026-11-18T13:45:00.000Z');
  assert.equal(rangeQuery(7, now), '?from=2026-11-12&to=2026-11-18');
  assert.equal(rangeQuery(30, now), '?from=2026-10-20&to=2026-11-18');
  assert.equal(rangeQuery(90, now), '?from=2026-08-21&to=2026-11-18');
});

void test('a model mark comes from the family in its id', () => {
  const cases: [string, string | null][] = [
    ['qwen3-0.6b', 'qwen'],
    ['Qwen2.5-Coder-7B', 'qwen'],
    ['llama3.2:3b', 'meta'],
    ['mistral-small', 'mistral'],
    ['gemma3:4b', 'gemma'],
    ['deepseek-r1', 'deepseek'],
    ['phi4-mini', 'microsoft'],
    ['gpt-oss-20b', 'openai'],
    ['claude-sonnet', 'claude'],
    ['granite3.3', 'ibm'],
    ['alpha-model', null],
    ['', null],
  ];
  for (const [id, family] of cases) assert.equal(modelFamily(id), family, id);
});

void test('daily series keep empty days as zero', () => {
  const requests = dailyRequests([
    {
      day: '2026-11-17',
      free: null,
      paid: null,
      observed: null,
      demand: [],
      origins: [],
      failures: [],
    },
  ] as unknown as Parameters<typeof dailyRequests>[0]);
  assert.deepEqual(requests, [{ day: '2026-11-17', free: 0, paid: 0 }]);
  const settled = dailySettled({
    aggregatedAt: null,
    backfillDone: false,
    days: [{ day: '2026-11-17', program: null, gyblos: null }],
    error: null,
  });
  assert.deepEqual(settled, [{ day: '2026-11-17', settled: 0n, settles: 0 }]);
});
