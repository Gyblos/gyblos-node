// Exercise file discovery and failure propagation through the hosted shard entrypoint.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

void test('runs literal paths exactly once, excludes dependencies and propagates a failing case', (context) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-shard-'));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const journal = join(dir, 'executed');
  mkdirSync(join(dir, 'node_modules', 'example'), { recursive: true });
  for (const file of [
    'seller-a',
    'seller-[a]',
    'node_modules/example/dependency',
  ]) {
    writeFileSync(
      join(dir, file + '.test.cjs'),
      [
        "const { test } = require('node:test');",
        "const { appendFileSync } = require('node:fs');",
        "test('fixture', () => {",
        `  appendFileSync(${JSON.stringify(journal)}, ${JSON.stringify(file + '\n')});`,
        file === 'seller-[a]'
          ? "  throw new Error('intentional failure');"
          : '',
        '});',
      ].join('\n'),
    );
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'tooling/ci-shards-cli.ts',
      '1/1',
      join(dir, '**/*.test.cjs'),
    ],
    { env, encoding: 'utf8' },
  );
  assert.ifError(result.error);
  assert.deepEqual(readFileSync(journal, 'utf8').trimEnd().split('\n').sort(), [
    'seller-[a]',
    'seller-a',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /intentional failure/);
});
