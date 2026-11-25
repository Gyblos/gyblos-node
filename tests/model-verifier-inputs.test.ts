import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MODEL_VERIFIER_CODES,
  ModelVerifierError,
} from '@gyblos/model-verifier/constants';
import { loadVerifierKey } from '@gyblos/model-verifier/key';
import { parseSellerTarget } from '@gyblos/model-verifier/seller';

const TARGET = {
  owner: '2nc4a8RxZMdWMMyBxAeKcT22HpAs5c3zgSTXnvYZ2L9S',
  nodeId: 'ab'.repeat(32),
  relayUrl: null,
  directAddresses: ['127.0.0.1:4433'],
};

function isCode(code: string) {
  return (error: unknown) =>
    error instanceof ModelVerifierError && error.code === code;
}

async function withHome<T>(run: (home: string) => Promise<T>) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-'));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

void test('a seller target is parsed strictly', () => {
  assert.deepEqual(parseSellerTarget(TARGET), TARGET);
  for (const value of [
    { ...TARGET, owner: 'not-an-address' },
    { ...TARGET, nodeId: 'AB'.repeat(32) },
    { ...TARGET, directAddresses: 'x' },
    { ...TARGET, extra: true },
    null,
  ])
    assert.throws(
      () => parseSellerTarget(value),
      isCode(MODEL_VERIFIER_CODES.INVALID_SELLER),
    );
});

void test('the verifier key is created once, private, and refused when missing or corrupt', async () => {
  await withHome(async (home) => {
    const path = join(home, 'nested', 'verifier.key');
    await assert.rejects(
      loadVerifierKey(path, false),
      isCode(MODEL_VERIFIER_CODES.INVALID_KEY),
    );
    const first = await loadVerifierKey(path, true);
    const again = await loadVerifierKey(path, false);
    assert.equal(again.address, first.address);
    if (process.platform !== 'win32')
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    const corrupt = join(home, 'corrupt.key');
    for (const text of ['{"seed":"zz"}\n', 'not json\n']) {
      await writeFile(corrupt, text, { mode: 0o600 });
      await assert.rejects(
        loadVerifierKey(corrupt, false),
        isCode(MODEL_VERIFIER_CODES.INVALID_KEY),
      );
    }
  });
});
