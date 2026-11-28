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

async function verifyError(t: TestContext, home: string, extra: string[]) {
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
  assert.equal(stderr.mock.calls.length, 1);
  return stderr.mock.calls[0]?.arguments;
}

function failure(code: string) {
  return [JSON.stringify({ ok: false, code })];
}

const { USAGE, REMOTE_REFERENCE, INVALID_SELLER } = MODEL_VERIFIER_CODES;

void test('a remote reference endpoint is rejected without explicit opt-in', async (t) => {
  await withHome(async (home) => {
    for (const endpoint of [
      'http://192.0.2.1:11434',
      'http://0xc0a80101:11434',
      'http://3232235521:11434',
      'http://example.com:11434',
      'http://[2001:db8::1]:11434',
      'http://127.example.com:11434',
      'http://127.0.0.1.evil.com:11434',
      'http://[::ffff:127.0.0.1]:11434',
      'http://localhost.:11434',
      'http://foo.localhost:11434',
    ])
      assert.deepEqual(
        await verifyError(t, home, ['--ollama', endpoint]),
        failure(REMOTE_REFERENCE),
        endpoint,
      );
  });
});

void test('a malformed or unusable reference endpoint URL is rejected', async (t) => {
  await withHome(async (home) => {
    for (const endpoint of [
      'not-a-url',
      'localhost:11434',
      'file://127.0.0.1',
      'ftp://127.0.0.1:11434',
      'ws://127.0.0.1:11434',
      'mailto:x@y.z',
      'http://user@127.0.0.1:11434',
      'http://127.0.0.1:11434/proxy',
      'http://127.0.0.1:11434/?q=1',
      'http://127.0.0.1:11434/#frag',
    ])
      assert.deepEqual(
        await verifyError(t, home, ['--ollama', endpoint]),
        failure(USAGE),
        endpoint,
      );
  });
});

void test('endpoint shape validation applies even with explicit opt-in', async (t) => {
  await withHome(async (home) => {
    for (const endpoint of [
      'localhost:11434',
      'file://127.0.0.1',
      'http://127.0.0.1:11434/proxy',
      'http://user:pass@127.0.0.1:11434',
    ])
      assert.deepEqual(
        await verifyError(t, home, [
          '--ollama',
          endpoint,
          '--allow-remote-ollama',
        ]),
        failure(USAGE),
        endpoint,
      );
  });
});

void test('loopback reference endpoints are accepted', async (t) => {
  await withHome(async (home) => {
    for (const endpoint of [
      'http://127.0.0.1:11434',
      'http://127.0.0.1:11434/',
      'http://127.1:11434',
      'http://0x7f000001:11434',
      'http://2130706433:11434',
      'http://localhost:11434',
      'http://[::1]:11434',
      'http://[0:0:0:0:0:0:0:1]:11434',
      'https://127.0.0.1:11434',
    ])
      assert.deepEqual(
        await verifyError(t, home, ['--ollama', endpoint]),
        failure(INVALID_SELLER),
        endpoint,
      );
  });
});

void test('the default reference endpoint is accepted', async (t) => {
  await withHome(async (home) => {
    assert.deepEqual(await verifyError(t, home, []), failure(INVALID_SELLER));
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
      failure(INVALID_SELLER),
    );
  });
});

void test('a value after the boolean opt-in is not swallowed as a positional', async (t) => {
  await withHome(async (home) => {
    assert.deepEqual(
      await verifyError(t, home, [
        '--ollama',
        'http://192.0.2.1:11434',
        '--allow-remote-ollama',
        'false',
      ]),
      failure(USAGE),
    );
  });
});

void test('malformed command line options are usage errors', async (t) => {
  await withHome(async (home) => {
    for (const extra of [
      ['--allow-remote-ollama=false'],
      ['--bogus-option'],
      ['--ollama'],
    ])
      assert.deepEqual(
        await verifyError(t, home, extra),
        failure(USAGE),
        extra.join(' '),
      );
  });
});
