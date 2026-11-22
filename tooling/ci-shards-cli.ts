// Run one Linux CI shard using the same test globs and Node options as the full suite.
import { globSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';

import history from './ci-shard-durations.json' with { type: 'json' };
import { assignShards } from './ci-shards';

const [selection, ...patterns] = process.argv.slice(2);
const [index, count] = (selection ?? '').split('/').map(Number);
if (
  !index ||
  !count ||
  !/^\d+\/\d+$/.test(selection ?? '') ||
  index > count ||
  !patterns.length
) {
  throw new Error('Expected shard index/count and test file patterns');
}
const files = globSync(patterns, {
  exclude: (name) => name === 'node_modules',
}).filter((path) => statSync(path).isFile());
if (!files.length) throw new Error('No test files matched the suite');
const selected = assignShards(
  files,
  new Map(Object.entries(history)),
  count,
  process.env.ORDINARY_LAB_PR === 'true',
)[index - 1];
if (!selected) throw new Error('Invalid shard');
if (selected.length) {
  const results = run({
    files: selected,
    concurrency: Math.max(1, availableParallelism() - 1),
  });
  results.on('test:summary', (summary) => {
    if (!summary.success) process.exitCode = 1;
  });
  results.compose(spec).pipe(process.stdout);
}
