// Verify that historical durations influence scheduling while live discovery owns coverage.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assignShards } from './ci-shards';

void test('assigns expensive files first and balances historical process duration', () => {
  const files = ['d', 'a', 'c', 'b'];
  const weights = new Map(Object.entries({ a: 10, b: 7, c: 6, d: 1 }));
  assert.deepEqual(assignShards(files, weights, 2), [['a', 'd'], ['b', 'c']]);
});

void test('covers additions, renames and overlapping patterns once and ignores stale history', () => {
  const files = ['new', 'known', 'renamed', 'new', 'fresh'];
  const weights = new Map(Object.entries({ known: 3, deleted: 100 }));
  const groups = assignShards(files, weights, 3);
  assert.deepEqual(groups.flat().sort(), ['fresh', 'known', 'new', 'renamed']);
  assert.deepEqual(assignShards([...files].reverse(), weights, 3), groups);
  assert.ok(groups.every((group) => group.length > 0));
});
