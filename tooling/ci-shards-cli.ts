// Run one Linux CI shard using the same test globs and Node options as the full suite.
import { spawnSync } from 'node:child_process';
import { globSync, statSync } from 'node:fs';

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
const files = globSync(patterns).filter((path) => statSync(path).isFile());
if (!files.length) throw new Error('No test files matched the suite');
const selected = assignShards(files, new Map(Object.entries(history)), count)[
  index - 1
];
if (!selected) throw new Error('Invalid shard');
if (selected.length) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', ...selected],
    {
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
