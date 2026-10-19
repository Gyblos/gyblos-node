import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = JSON.parse(
  readFileSync(resolve(ROOT, 'tooling/test-files.json'), 'utf8'),
);
const DISCOVERED = readdirSync(resolve(ROOT, 'tests'), { recursive: true })
  .filter((file) => String(file).endsWith('.test.ts'))
  .map(String)
  .sort();
assert.ok(EXPECTED.length > 0, 'The regression suite must not be empty.');
assert.deepEqual(
  DISCOVERED,
  EXPECTED,
  'Missing or unlisted regression suites.',
);
const RESULT = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...EXPECTED.map((file) => `tests/${file}`)],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);
if (RESULT.error) throw RESULT.error;
assert.equal(
  RESULT.signal,
  null,
  'The test runner was terminated by a signal.',
);
process.exitCode = RESULT.status ?? 1;
