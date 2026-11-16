// Release metadata is synthetic and bounded; no remote calls or executable downloads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkDesktopUpdate } from '@gyblos/desktop/update-check';

const current = '0.1.0-beta.11';
const release = (tag = '0.1.0-beta.12') => ({
  tag_name: 'v' + tag,
  draft: false,
  assets: [{ name: 'gyblos-desktop-' + tag + '-darwin-arm64.zip' }],
});
void test('desktop reports newer beta with a matching desktop asset, without following a release URL', async () => {
  let reads = 0;
  const result = await checkDesktopUpdate(
    current,
    'darwin',
    'arm64',
    async (input, init) => {
      reads++;
      assert.equal(
        String(input),
        'https://api.github.com/repos/Gyblos/gyblos-node/releases?per_page=10',
      );
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.method, 'GET');
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return Response.json([release()]);
    },
  );
  assert.deepEqual(result, { current, available: '0.1.0-beta.12' });
  assert.equal(reads, 1);
});
void test('desktop ignores older, draft, incomplete and malformed releases but recognizes stable precedence', async () => {
  for (const record of [
    release(current),
    release('0.1.0-beta.9'),
    release('0.1.0-beta.01'),
    { ...release(), draft: true },
    { ...release(), assets: [] },
  ]) {
    assert.equal(
      (
        await checkDesktopUpdate(current, 'darwin', 'arm64', async () =>
          Response.json([record]),
        )
      ).available,
      null,
    );
  }
  assert.equal(
    (
      await checkDesktopUpdate(current, 'darwin', 'arm64', async () =>
        Response.json([release('0.1.0')]),
      )
    ).available,
    '0.1.0',
  );
  assert.equal(
    (
      await checkDesktopUpdate('0.1.0', 'darwin', 'arm64', async () =>
        Response.json([release()]),
      )
    ).available,
    null,
  );
});
void test('desktop update failures, oversized bodies and cancellation are silent and bounded', async () => {
  const aborted = AbortSignal.abort();
  let calls = 0;
  assert.equal(
    (
      await checkDesktopUpdate(
        current,
        'darwin',
        'arm64',
        async () => {
          calls++;
          return Response.json([]);
        },
        aborted,
      )
    ).available,
    null,
  );
  assert.equal(calls, 0);
  let cancelled = false;
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(262145));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(
    (
      await checkDesktopUpdate(
        current,
        'darwin',
        'arm64',
        async () => new Response(stream),
      )
    ).available,
    null,
  );
  assert.equal(cancelled, true);
  assert.equal(
    (
      await checkDesktopUpdate(current, 'darwin', 'arm64', async () => {
        throw new Error('private');
      })
    ).available,
    null,
  );
});
