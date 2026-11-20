// Protects how renders read the explorer's discovery snapshot: from KV, never the index, reusing a recent
// read; when the index stops answering, the last catalog stays shown with when it was read; a failing KV
// or a stored value of another shape never breaks the page.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { DISCOVERY } from '@gyblos/explorer/constants';
import {
  loadSnapshot,
  refreshDiscovery,
  type DiscoveryKv,
} from '@gyblos/explorer/discovery-snapshot';

import { fakeIndex, fakeKv, MINUTE } from './support/explorer-discovery';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

void test('when the index stops answering, the run says so and the last catalog stays shown, with when it was read, on every render', async () => {
  const { kv } = fakeKv();
  fakeIndex({ models: { a: ['n1'] } });
  await refreshDiscovery(kv, () => 1000);
  fakeIndex({ models: { a: ['n1'] }, down: true });
  assert.deepEqual(await refreshDiscovery(kv, () => 1000 + 2 * MINUTE), [
    'models',
  ]);

  const before = await loadSnapshot(kv, 1000 + DISCOVERY.staleAfterMs);
  assert.equal(before.datedAt, null);
  for (let step = 1; step <= 5; step += 1) {
    const late = await loadSnapshot(
      kv,
      1000 + DISCOVERY.staleAfterMs + step * DISCOVERY.reuseMs,
    );
    assert.equal(late.datedAt, 1000);
    assert.equal(late.error, null);
    assert.deepEqual(
      late.sellers.map((seller) => seller.nodeId),
      ['n1'],
    );
    assert.ok(late.sellers[0]?.uptime);
  }
});

void test('renders read KV, not the index, and reuse a recent read of the same KV', async () => {
  const { kv, gets } = fakeKv();
  fakeIndex({ models: { a: ['n1'] } });
  await refreshDiscovery(kv, () => 0);
  const { requests } = fakeIndex({ models: { a: ['n1'] } });
  for (let render = 0; render < 50; render += 1)
    assert.equal((await loadSnapshot(kv, render)).sellers.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(gets(), 2);
  await loadSnapshot(kv, DISCOVERY.reuseMs);
  assert.equal(gets(), 3);
  // Another namespace is read, not served from this one's read.
  const other = fakeKv();
  assert.equal(
    (await loadSnapshot(other.kv, DISCOVERY.reuseMs)).error,
    'discovery not read yet',
  );
});

void test('a failing KV serves the last read of it, or the index is unavailable', async () => {
  const { kv } = fakeKv();
  fakeIndex({ models: { a: ['n1'] } });
  await refreshDiscovery(kv, () => 0);
  assert.equal((await loadSnapshot(kv, 0)).sellers.length, 1);
  kv.get = () => Promise.reject(new Error('kv down'));
  const fallback = await loadSnapshot(kv, DISCOVERY.reuseMs);
  assert.equal(fallback.error, null);
  assert.equal(fallback.sellers.length, 1);

  const failing: DiscoveryKv = {
    get: () => Promise.reject(new Error('kv down')),
    put: () => Promise.resolve(),
  };
  assert.equal((await loadSnapshot(failing, 0)).error, 'KV unavailable');
});

void test('a stored value of another shape is ignored, and the next run replaces it', async () => {
  const { kv, stored } = fakeKv();
  stored.set(DISCOVERY.storedKey, '{}');
  assert.equal((await loadSnapshot(kv, 0)).error, 'discovery not read yet');
  fakeIndex({ models: { a: ['n1'] } });
  await refreshDiscovery(kv, () => 0);
  assert.equal((await loadSnapshot(kv, DISCOVERY.reuseMs)).sellers.length, 1);
});
