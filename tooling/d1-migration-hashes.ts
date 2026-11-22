// Records each new D1 migration file's SHA-256 once in migrations/meta/_sha256.json, so tests reject
// any later edit. Recorded hashes are never rewritten; an unfilled `--custom` placeholder waits.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CUSTOM_PLACEHOLDER =
  '-- Custom SQL migration file, put your code below! --';

const text = (path: string) =>
  readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

// Returns the files recorded by this call.
export function recordMigrationHashes(appDir: string): string[] {
  const migrationsDir = join(appDir, 'migrations');
  const manifestPath = join(migrationsDir, 'meta', '_sha256.json');
  const recorded: Record<string, string> = JSON.parse(text(manifestPath));
  const added: string[] = [];
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
  return added;
}
