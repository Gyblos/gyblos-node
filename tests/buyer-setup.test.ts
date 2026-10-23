// Exercises buyer tokenizer preparation in an isolated checkout with synthetic public artifacts.
// The real downloader and CLI run offline; no role keys, engine, RPC or payment is used.
import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { TOKENIZER_DIR, TOKENIZER_FILES } from '@gyblos/config';
import { NODE_ERROR_CODES } from '@gyblos/node/constants';

import { preparation } from './support/tokenizer-preparation.js';

void test('a fresh buyer prepares pinned tokenizer files without an engine or role setup', async () => {
  const { directory, result, artifacts } = await preparation();
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      await readFile(join(directory, TOKENIZER_FILES.tokenizer), 'utf8'),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(join(directory, TOKENIZER_FILES.config), 'utf8'),
      artifacts.config,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('buyer preparation rejects a substituted tokenizer before writing artifacts', async () => {
  const { directory, result } = await preparation('tokenizer');
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
    await assert.rejects(readFile(join(directory, TOKENIZER_FILES.tokenizer)), {
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('a substituted config leaves both previously verified tokenizer files unchanged', async () => {
  const { directory, result, artifacts } = await preparation('config', true);
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
    assert.equal(
      await readFile(join(directory, TOKENIZER_FILES.tokenizer), 'utf8'),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(join(directory, TOKENIZER_FILES.config), 'utf8'),
      artifacts.config,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('buyer preparation caps streamed bodies without trusting Content-Length', async () => {
  const { directory, result, artifacts } = await preparation(
    false,
    true,
    'oversize',
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(NODE_ERROR_CODES.TOKENIZER_DOWNLOAD_TOO_LARGE),
    );
    for (const [name, path] of Object.entries(TOKENIZER_FILES))
      assert.equal(
        await readFile(join(directory, path), 'utf8'),
        artifacts[name as keyof typeof artifacts],
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('a failed staged write preserves existing artifacts and removes temporary files', async () => {
  const { directory, result, artifacts } = await preparation(
    false,
    true,
    'write',
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Synthetic write failure/);
    assert.equal(
      await readFile(join(directory, TOKENIZER_FILES.tokenizer), 'utf8'),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(join(directory, TOKENIZER_FILES.config), 'utf8'),
      artifacts.config,
    );
    assert.deepEqual((await readdir(join(directory, TOKENIZER_DIR))).sort(), [
      'tokenizer.json',
      'tokenizer_config.json',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
