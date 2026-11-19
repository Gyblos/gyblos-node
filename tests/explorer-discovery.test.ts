// Protects the explorer's reads of the discovery index (which answers no-store): one read is a bounded
// number of seller pages and uptimes and says when it stopped short, every request has a timeout so a
// slow source cannot hold a render, and reads are shared by the renders of a data center so the load
// does not grow with viewers: one reader at a time, a back-off after a failure, partial reads shared
// briefly.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { DISCOVERY } from '@gyblos/explorer/constants';
import { getDiscovery, readDiscovery } from '@gyblos/explorer/discovery';
import { fetchJson } from '@gyblos/explorer/fetch-json';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A data center's cache as the Workers Cache API offers it (caches.default), in memory, expiring
// entries by their max-age against the test's clock.
function fakeStore(clock: { now: number }) {
  const stored = new Map<string, { body: string; until: number }>();
  return {
    stored,
    store: {
      match: async (key: string) => {
        const entry = stored.get(key);
        return entry && clock.now < entry.until
          ? new Response(entry.body)
          : undefined;
      },
      put: async (key: string, response: Response) => {
        const age = Number(
          /max-age=(\d+)/.exec(
            response.headers.get('cache-control') ?? '',
          )?.[1],
        );
        stored.set(key, {
          body: await response.text(),
          until: clock.now + age * 1000,
        });
      },
      delete: async (key: string) => stored.delete(key),
    },
  };
}
const SECOND = 1000;
const countReads = (paths: string[]) =>
  paths.filter((path) => path.endsWith('/models')).length;

// A fake index with `models` models, each listing one page of `perPage` distinct sellers; it answers
// /network only when `network` is set (without it, a read is partial).
function fakeIndex(
  models: number,
  paths: string[],
  perPage = 1,
  network = false,
) {
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
    if (network && url.pathname.endsWith('/network'))
      return json({
        counts: { total: 0, online: 0, offline: 0, unpublished: 0 },
        nodes: [],
        truncated: false,
        generatedAt: 1,
      });
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

void test('a fresh read serves every render, and only one render reads when it ages', async () => {
  const clock = { now: 1_000_000 };
  const { store } = fakeStore(clock);
  const paths: string[] = [];
  fakeIndex(2, paths, 1, true);
  const first = await readDiscovery(store, clock.now);
  assert.equal(first.error, null);
  assert.ok(first.network);
  assert.equal(countReads(paths), 1);

  // A complete read stays fresh for 30 s.
  clock.now += 25 * SECOND;
  assert.deepEqual(await readDiscovery(store, clock.now), first);
  assert.equal(countReads(paths), 1);

  // Past its freshness: one render reads, and a render arriving while it reads does not.
  clock.now += 10 * SECOND;
  const reading = readDiscovery(store, clock.now);
  await new Promise((resolve) => setImmediate(resolve));
  await readDiscovery(store, clock.now);
  await reading;
  assert.equal(countReads(paths), 2);
});

void test('while one render reads, the others serve the last read', async () => {
  const clock = { now: 1_000_000 };
  const { store } = fakeStore(clock);
  const paths: string[] = [];
  fakeIndex(1, paths);
  const first = await readDiscovery(store, clock.now);
  clock.now += 31 * SECOND;
  await store.put(
    'https://explorer.gyblos.com/_shared/discovery/lease',
    Response.json('reading', { headers: { 'cache-control': 'max-age=15' } }),
  );
  assert.deepEqual(await readDiscovery(store, clock.now), first);
  assert.equal(countReads(paths), 1);
});

void test('a failed read backs off: no render reads again until the back-off ends', async () => {
  const clock = { now: 1_000_000 };
  const { store, stored } = fakeStore(clock);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('{}', { status: 429 });
  }) as typeof fetch;
  assert.ok((await readDiscovery(store, clock.now)).error);
  assert.ok((await readDiscovery(store, clock.now + 5 * SECOND)).error);
  assert.equal(calls, 1);
  assert.equal(
    stored.has('https://explorer.gyblos.com/_shared/discovery'),
    false,
  );

  const paths: string[] = [];
  fakeIndex(1, paths);
  clock.now += 16 * SECOND;
  assert.equal((await readDiscovery(store, clock.now)).error, null);
  assert.equal(countReads(paths), 1);
});

void test('after a good read, a failed one serves the last good read', async () => {
  const clock = { now: 1_000_000 };
  const { store } = fakeStore(clock);
  fakeIndex(1, []);
  const good = await readDiscovery(store, clock.now);
  globalThis.fetch = (async () =>
    new Response('{}', { status: 503 })) as typeof fetch;
  clock.now += 31 * SECOND;
  assert.deepEqual(await readDiscovery(store, clock.now), good);
});

void test('a partial read is shared for a shorter time', async () => {
  const clock = { now: 1_000_000 };
  const { store } = fakeStore(clock);
  const paths: string[] = [];
  // No /network answer: the read is partial.
  fakeIndex(1, paths);
  const partial = await readDiscovery(store, clock.now);
  assert.equal(partial.network, null);
  clock.now += 16 * SECOND;
  await readDiscovery(store, clock.now);
  assert.equal(countReads(paths), 2);
});

void test('without a shared cache, or with one that fails, every render still reads', async () => {
  fakeIndex(1, []);
  assert.equal((await getDiscovery()).error, null);
  const broken = {
    match: () => Promise.reject(new Error('cache down')),
    put: () => Promise.reject(new Error('cache down')),
    delete: () => Promise.reject(new Error('cache down')),
  };
  const snapshot = await readDiscovery(broken, 1_000_000);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.sellers.length, 1);
});
