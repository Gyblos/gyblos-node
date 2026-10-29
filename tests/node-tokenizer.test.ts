// `pnpm node:tokenizer` is the product command that prepares the pinned recount tokenizer for any role:
// it writes only verified artifacts, refuses a substituted file and needs no role, engine or RPC.
// Synthetic public artifacts in a disposable checkout; no real download.
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { artifactLayout, preparation } from './support/tokenizer-preparation';

void test('node:tokenizer prepares the pinned tokenizer without a role or engine', async () => {
  const { directory, result, artifacts } = await preparation(
    false,
    false,
    undefined,
    false,
    [],
    'node',
  );
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Pinned tokenizer verified/);
    for (const [name, path] of Object.entries(artifactLayout().tokenizerFiles))
      assert.equal(
        await readFile(join(directory, path), 'utf8'),
        artifacts[name as keyof typeof artifacts],
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('node:tokenizer refuses a substituted tokenizer and writes nothing', async () => {
  const { directory, result } = await preparation(
    'tokenizer',
    false,
    undefined,
    false,
    [],
    'node',
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
    await assert.rejects(
      readFile(join(directory, artifactLayout().tokenizerFiles.tokenizer)),
      { code: 'ENOENT' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
