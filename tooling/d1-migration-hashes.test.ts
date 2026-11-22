import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

import { recordMigrationHashes } from './d1-migration-hashes';

const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

function app(files: Record<string, string>, recorded: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'd1-hashes-'));
  mkdirSync(join(dir, 'migrations', 'meta'), { recursive: true });
  for (const [name, sql] of Object.entries(files))
    writeFileSync(join(dir, 'migrations', name), sql);
  writeFileSync(
    join(dir, 'migrations', 'meta', '_sha256.json'),
    JSON.stringify(recorded),
  );
  const manifest = (): Record<string, string> =>
    JSON.parse(
      readFileSync(join(dir, 'migrations', 'meta', '_sha256.json'), 'utf8'),
    );
  return { dir, manifest };
}

void test('records new files and never rewrites a recorded hash', (context) => {
  const { dir, manifest } = app(
    {
      '0001_old.sql': 'CREATE TABLE a (id TEXT);\n',
      '0002_new.sql': 'CREATE TABLE b (id TEXT);\r\n',
    },
    { '0001_old.sql': 'recorded-before-an-edit' },
  );
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(recordMigrationHashes(dir), ['0002_new.sql']);
  assert.deepEqual(manifest(), {
    '0001_old.sql': 'recorded-before-an-edit',
    '0002_new.sql': sha256('CREATE TABLE b (id TEXT);\n'),
  });
  assert.deepEqual(recordMigrationHashes(dir), []);
});

void test('skips an unfilled --custom placeholder until its body is written', (context) => {
  const placeholder = '-- Custom SQL migration file, put your code below! --';
  const { dir, manifest } = app({ '0008_backfill.sql': placeholder }, {});
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(recordMigrationHashes(dir), []);
  assert.deepEqual(manifest(), {});
  const filled = `${placeholder}\nUPDATE t SET a = 1;\n`;
  writeFileSync(join(dir, 'migrations', '0008_backfill.sql'), filled);
  assert.deepEqual(recordMigrationHashes(dir), ['0008_backfill.sql']);
  assert.deepEqual(manifest(), { '0008_backfill.sql': sha256(filled) });
});
