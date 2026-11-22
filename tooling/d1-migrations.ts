import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordMigrationHashes } from './d1-migration-hashes';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const D1_APPS = ['apps/discovery-index', 'apps/metrics-collector'] as const;

function record(appDir: string) {
  for (const file of recordMigrationHashes(appDir))
    console.log(`Recorded ${file}.`);
}

function generate(appDir: string, drizzleArguments: string[]) {
  const require = createRequire(import.meta.url);
  const bin = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
  const result = spawnSync(
    process.execPath,
    [bin, 'generate', ...drizzleArguments],
    { cwd: appDir, stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  record(appDir);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'hashes' && rest.length === 0)
  for (const app of D1_APPS) record(join(ROOT, app));
else if (command === 'generate' && rest[0] !== undefined)
  generate(resolve(rest[0]), rest.slice(1));
else
  throw new Error(
    'Usage: d1-migrations.ts hashes | generate <app dir> [drizzle-kit options]',
  );
