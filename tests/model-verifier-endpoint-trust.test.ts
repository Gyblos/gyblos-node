import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { MODEL_VERIFIER_CODES } from '@gyblos/model-verifier/constants';
import { main } from '@gyblos/model-verifier/main';

async function withHome<T>(run: (home: string) => Promise<T>) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verifier-'));
  try {
    return await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function verifyError(
  t: TestContext,
  home: string,
  extra: string[],
) {
  const stderr = t.mock.method(console, 'error', () => {});
  const exit = await main([
    'verify',
    '--seller',
    join(home, 'missing-seller.json'),
    '--model',
    'qwen3-1.7b',
    ...extra,
  ]);
  assert.equal(exit, 1);
  return stderr.mock.calls.at(-1)?.arguments;
}

function failure(code: string) {
  return [JSON.stringify({ ok: false, code })];
}

void test('a remote reference endpoint is rejected without explicit opt-in', async (t) => {
  await withHome(async (home) => {
    for (const endpoint of [
      'http://192.0.2.1:11434',
      'http://example.com:11434',
      'http://127.example.com:11434',
    ])
      assert.deepEqual(
        await verifyError(t, home, ['--ollama', endpoint]),
        failure(MODEL_VERIFIER_CODES.REMOTE_REFERENCE),
      );
  });
});

void test('a malformed reference endpoint URL is rejected', async (t) => {
  await withHome(async (home) => {
    assert.deepEqual(
      await verifyError(t, home, ['--ollama', 'not-a-url']),
      failure(MODEL_VERIFIER_CODES.USAGE),
    );
  });
});

void test('loopback reference endpoints are accepted', async (t) => {
  await withHome(async (home) => {
    for (const endpoint of [
      'http://127.0.0.1:11434',
      'http://127.1:11434',
      'http://localhost:11434',
      'http://[::1]:11434',
    ])
      assert.deepEqual(
        await verifyError(t, home, ['--ollama', endpoint]),
        failure(MODEL_VERIFIER_CODES.INVALID_SELLER),
      );
  });
});

void test('the default reference endpoint is accepted', async (t) => {
  await withHome(async (home) => {
    assert.deepEqual(
      await verifyError(t, home, []),
      failure(MODEL_VERIFIER_CODES.INVALID_SELLER),
    );
  });
});

void test('a remote reference endpoint is accepted with explicit opt-in', async (t) => {
  await withHome(async (home) => {
    assert.deepEqual(
      await verifyError(t, home, [
        '--ollama',
        'http://192.0.2.1:11434',
        '--allow-remote-ollama',
      ]),
      failure(MODEL_VERIFIER_CODES.INVALID_SELLER),
    );
  });
});
