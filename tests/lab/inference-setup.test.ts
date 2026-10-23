// Exercises the lab setup entry using synthetic downloads; no engine or network is started.
import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { NODE_ERROR_CODES } from '@gyblos/node/constants';

import {
  artifactLayout,
  preparation,
} from '../support/tokenizer-preparation.js';

void test('lab setup verifies before replacing either artifact', async () => {
  const { directory, result, artifacts } = await preparation(
    'config',
    true,
    undefined,
    true,
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /hash mismatch/);
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.tokenizer),
        'utf8',
      ),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.config),
        'utf8',
      ),
      artifacts.config,
    );
    assert.deepEqual(
      (await readdir(join(directory, artifactLayout().tokenizer))).sort(),
      ['tokenizer.json', 'tokenizer_config.json'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('lab setup caps downloads before replacing artifacts', async () => {
  const { directory, result, artifacts } = await preparation(
    false,
    true,
    'oversize',
    true,
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      new RegExp(NODE_ERROR_CODES.TOKENIZER_DOWNLOAD_TOO_LARGE),
    );
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.tokenizer),
        'utf8',
      ),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.config),
        'utf8',
      ),
      artifacts.config,
    );
    assert.deepEqual(
      (await readdir(join(directory, artifactLayout().tokenizer))).sort(),
      ['tokenizer.json', 'tokenizer_config.json'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('lab setup preserves artifacts after a staged write failure', async () => {
  const { directory, result, artifacts } = await preparation(
    false,
    true,
    'write',
    true,
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Synthetic write failure/);
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.tokenizer),
        'utf8',
      ),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.config),
        'utf8',
      ),
      artifacts.config,
    );
    assert.deepEqual(
      (await readdir(join(directory, artifactLayout().tokenizer))).sort(),
      ['tokenizer.json', 'tokenizer_config.json'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('lab setup prepares valid artifacts before probing the local engine', async () => {
  const { directory, result, artifacts } = await preparation(
    false,
    true,
    undefined,
    true,
  );
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Setup needs unused loopback port/);
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.tokenizer),
        'utf8',
      ),
      artifacts.tokenizer,
    );
    assert.equal(
      await readFile(
        join(directory, artifactLayout().tokenizerFiles.config),
        'utf8',
      ),
      artifacts.config,
    );
    assert.deepEqual(
      (await readdir(join(directory, artifactLayout().tokenizer))).sort(),
      ['tokenizer.json', 'tokenizer_config.json'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
