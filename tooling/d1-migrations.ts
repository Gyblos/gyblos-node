// Runs drizzle-kit generate for a D1 Worker and records each new migration file's SHA-256 once in
// migrations/meta/_sha256.json, so tests/drizzle-migrations.test.ts rejects any later edit.
// Recorded hashes are never rewritten; an unfilled `--custom` placeholder is left unrecorded.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const D1_APPS = ['apps/discovery-index', 'apps/metrics-collector'] as const;
const CUSTOM_PLACEHOLDER =
  '-- Custom SQL migration file, put your code below! --';
const MANIFEST = join('migrations', 'meta', '_sha256.json');

const text = (path: string) =>
  readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

function record(appDir: string) {
  const manifestPath = join(appDir, MANIFEST);
  const recorded: Record<string, string> = JSON.parse(text(manifestPath));
  const added: string[] = [];
  const migrationsDir = join(appDir, 'migrations');
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    if (file in recorded) continue;
    const sql = text(join(migrationsDir, file));
    if (sql.trim() === CUSTOM_PLACEHOLDER) {
      console.log(
        `${file}: write its data statements, then run pnpm db:hashes to record it.`,
      );
      continue;
    }
    recorded[file] = createHash('sha256').update(sql).digest('hex');
    added.push(file);
  }
  writeFileSync(manifestPath, `${JSON.stringify(recorded, null, 2)}\n`);
  for (const file of added) console.log(`Recorded ${file}.`);
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
