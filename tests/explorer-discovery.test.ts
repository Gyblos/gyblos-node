// Protects the explorer's reads of the discovery index, whose answers are not cached: one read is a
// bounded number of seller pages and uptimes and says when it stopped short, every request has a
// timeout so a slow source cannot hold a render, and a successful read is shared by the renders of a
// data center (never a failed one).
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { DISCOVERY } from '@gyblos/explorer/constants';
import { getDiscovery } from '@gyblos/explorer/discovery';
import { fetchJson } from '@gyblos/explorer/fetch-json';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, 'caches');
});

// A data center's cache as the Workers Cache API offers it (caches.default), in memory.
function fakeSharedCache() {
  const stored = new Map<string, string>();
  Object.assign(globalThis, {
    caches: {
      default: {
        match: async (key: string) => {
          const body = stored.get(key);
          return body === undefined ? undefined : new Response(body);
        },
        put: async (key: string, response: Response) => {
          stored.set(key, await response.text());
        },
      },
    },
  });
  return stored;
}

// A fake index with `models` models, each listing one page of `perPage` distinct sellers.
function fakeIndex(models: number, paths: string[], perPage = 1) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    const json = (body: unknown) => Response.json(body);
    if (url.pathname.endsWith('/models'))
      return json({
        generatedAt: 1,
        models: Array.from({ length: models }, (_, index) => ({
          id: `m${index}`,
        })),
      });
    if (url.pathname.endsWith('/sellers')) {
      const model = url.searchParams.get('model') ?? '';
      return json({
        sellers: Array.from({ length: perPage }, (_, index) => ({
          catalog: {
            record: { nodeId: `n-${model}-${index}`, owner: 'o', models: [] },
          },
        })),
        next: null,
      });
    }
    if (url.pathname.endsWith('/uptime'))
      return json({ firstSeenAt: 1, windows: [] });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

void test('a small index is read whole', async () => {
  const paths: string[] = [];
  fakeIndex(3, paths);
  const snapshot = await getDiscovery();
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.truncated, false);
  assert.equal(snapshot.sellers.length, 3);
  assert.ok(snapshot.sellers.every((seller) => seller.uptime));
});

void test('a large index is read within the bounds and marked incomplete', async () => {
  const paths: string[] = [];
  fakeIndex(DISCOVERY.maxSellerPages + 5, paths);
  const snapshot = await getDiscovery();
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.truncated, true);
  assert.equal(
    paths.filter((path) => path.endsWith('/sellers')).length,
    DISCOVERY.maxSellerPages,
  );
});

void test('past the uptime bound, the other sellers show none and the list is marked incomplete', async () => {
  const paths: string[] = [];
  fakeIndex(1, paths, DISCOVERY.maxUptimeReads + 10);
  const snapshot = await getDiscovery();
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.sellers.length, DISCOVERY.maxUptimeReads + 10);
  assert.equal(
    paths.filter((path) => path.endsWith('/uptime')).length,
    DISCOVERY.maxUptimeReads,
  );
  assert.equal(
    snapshot.sellers.filter((seller) => seller.uptime === null).length,
    10,
  );
});

void test('a source that never answers is given up after the timeout', async () => {
  // A fetch that answers only when its signal aborts, as a stalled connection would.
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(init.signal?.reason),
      );
    })) as typeof fetch;
  await assert.rejects(fetchJson('https://source.test/x', 'test', 20), {
    name: 'TimeoutError',
  });
});

void test('a successful read is shared by later renders, and a failed one is not', async () => {
  const stored = fakeSharedCache();
  const paths: string[] = [];
  globalThis.fetch = (async () =>
    new Response('{}', { status: 503 })) as typeof fetch;
  assert.ok((await getDiscovery()).error);
  assert.equal(stored.size, 0);

  fakeIndex(2, paths);
  const first = await getDiscovery();
  const reads = paths.length;
  const second = await getDiscovery();
  assert.equal(first.error, null);
  assert.deepEqual(second, first);
  assert.equal(paths.length, reads);
});

void test('a failing shared cache never stops the read', async () => {
  Object.assign(globalThis, {
    caches: {
      default: {
        match: () => Promise.reject(new Error('cache down')),
        put: () => Promise.reject(new Error('cache down')),
      },
    },
  });
  fakeIndex(1, []);
  const snapshot = await getDiscovery();
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.sellers.length, 1);
});
