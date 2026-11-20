// Protects the explorer's read of the discovery index (which answers no-store): the Worker's scheduled
// run reads it within a fixed number of requests into a KV snapshot, whatever the number of viewers;
// what does not fit waits for the next run and is shown as missing, never as absent; a failed run keeps
// the last snapshot, which is shown as old once it is; renders read KV, not the index.
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { DISCOVERY } from '@gyblos/explorer/constants';
import {
  loadSnapshot,
  readIndex,
  refreshDiscovery,
  snapshotOf,
  STORED_KEY,
  type DiscoveryKv,
} from '@gyblos/explorer/discovery';
import { fetchJson } from '@gyblos/explorer/fetch-json';
import { summarizeOffers } from '@gyblos/explorer/offers';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface IndexShape {
  // Sellers per model, by model id.
  models: Record<string, string[]>;
  // Node ids /network calls offline; null for an index without /network.
  offline?: string[] | null;
  down?: boolean;
  failUptime?: Set<string>;
  perPage?: number;
}
// A fake discovery index over `shape`; returns every requested path with its query.
function fakeIndex(shape: IndexShape) {
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    if (shape.down) return new Response('{}', { status: 503 });
    const json = (body: unknown) => Response.json(body);
    if (url.pathname.endsWith('/models'))
      return json({
        generatedAt: 7,
        models: Object.keys(shape.models).map((id) => ({ id })),
      });
    if (url.pathname.endsWith('/sellers')) {
      const model = url.searchParams.get('model') ?? '';
      const listed = shape.models[model] ?? [];
      const perPage = shape.perPage ?? Number(url.searchParams.get('limit'));
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const end = Math.min(start + perPage, listed.length);
      return json({
        sellers: listed.slice(start, end).map((nodeId) => ({
          catalog: {
            record: {
              nodeId,
              owner: 'o',
              models: [
                {
                  modelId: model,
                  variant: null,
                  quantization: null,
                  contextTokens: 8,
                  pricing: {
                    inputAtomicPerMtok: '0',
                    outputAtomicPerMtok: '0',
                  },
                },
              ],
            },
          },
        })),
        next: end < listed.length ? String(end) : null,
      });
    }
    if (url.pathname.endsWith('/uptime')) {
      if (shape.failUptime?.has(url.searchParams.get('node') ?? ''))
        return new Response('{}', { status: 500 });
      return json({ firstSeenAt: 1, windows: [{ days: 1, ratio: 0.5 }] });
    }
    if (url.pathname.endsWith('/network') && shape.offline !== null) {
      const offline = new Set(shape.offline ?? []);
      const all = [...new Set(Object.values(shape.models).flat())];
      const entries = all.map((nodeId) => ({
        nodeId,
        state: offline.has(nodeId) ? 'offline' : 'online',
        firstSeenAt: 1,
        lastSeenAt: 1,
        models: [],
      }));
      return json({
        counts: {
          total: entries.length,
          online: entries.length - offline.size,
          offline: offline.size,
          unpublished: 0,
        },
        nodes: entries,
        truncated: false,
        generatedAt: 1,
      });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return requests;
}
const count = (requests: string[], path: string) =>
  requests.filter((request) => request.includes(path)).length;
const nodes = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, index) => `${prefix}${index}`);

function fakeKv() {
  const stored = new Map<string, string>();
  let gets = 0;
  const kv: DiscoveryKv = {
    get: async (key) => {
      gets += 1;
      return stored.get(key) ?? null;
    },
    put: async (key, value) => {
      stored.set(key, value);
    },
  };
  return { kv, stored, gets: () => gets };
}
const MINUTE = 60 * 1000;

void test('a run reads a small index whole, at the largest page size, and the render shows it', async () => {
  const requests = fakeIndex({ models: { a: ['n1', 'n2'], b: ['n2'] } });
  const stored = await readIndex(null, () => 100);
  assert.equal(requests.length, 1 + 1 + 2 + 2);
  assert.ok(
    requests
      .filter((request) => request.includes('/sellers'))
      .every((request) =>
        request.includes(`limit=${DISCOVERY.sellersPerPage}`),
      ),
  );
  const snapshot = snapshotOf(stored, 100);
  assert.equal(snapshot.error, null);
  assert.equal(snapshot.staleFrom, null);
  assert.deepEqual(snapshot.unreadModels, []);
  assert.deepEqual(
    snapshot.sellers.map((seller) => seller.nodeId),
    ['n1', 'n2'],
  );
  assert.ok(snapshot.sellers.every((seller) => seller.uptime));
  assert.equal(snapshot.generatedAt, 7);
});

void test('seller pages are followed to the end', async () => {
  const requests = fakeIndex({ models: { a: nodes('n', 5) }, perPage: 2 });
  const snapshot = snapshotOf(await readIndex(null, () => 1), 1);
  assert.equal(count(requests, '/sellers'), 3);
  assert.equal(snapshot.sellers.length, 5);
});

void test('a cursor that never ends fails the run instead of looping', async () => {
  fakeIndex({
    models: { a: nodes('n', DISCOVERY.maxSellerPages + 1) },
    perPage: 1,
  });
  await assert.rejects(
    readIndex(null, () => 1),
    /more than/,
  );
});

void test('a run stays within its budget; models it could not read are unknown, then read first', async () => {
  const models = Object.fromEntries(
    nodes('m', DISCOVERY.maxRequestsPerRun).map((id) => [id, [`node-${id}`]]),
  );
  let requests = fakeIndex({ models });
  const first = await readIndex(null, () => 1);
  assert.equal(requests.length, DISCOVERY.maxRequestsPerRun);
  const listed = DISCOVERY.maxRequestsPerRun - 2;
  const unread = snapshotOf(first, 1).unreadModels;
  assert.equal(unread.length, DISCOVERY.maxRequestsPerRun - listed);
  assert.equal(snapshotOf(first, 1).sellers.length, listed);

  requests = fakeIndex({ models });
  const second = await readIndex(first, () => 2);
  assert.ok(requests.length <= DISCOVERY.maxRequestsPerRun);
  for (const modelId of unread)
    assert.ok(
      requests.some((request) => request.includes(`model=${modelId}&`)),
    );
  assert.deepEqual(snapshotOf(second, 2).unreadModels, []);
});

void test('uptimes are read in turns within the budget, oldest first, and again only once old', async () => {
  const sellers = nodes('n', 100);
  let now = 0;
  let requests = fakeIndex({ models: { a: sellers } });
  const first = await readIndex(null, () => now);
  assert.equal(requests.length, DISCOVERY.maxRequestsPerRun);
  const firstRead = count(requests, '/uptime');
  assert.equal(firstRead, DISCOVERY.maxRequestsPerRun - 3);
  const snapshot = snapshotOf(first, now);
  assert.equal(snapshot.sellers.length, 100);
  assert.equal(
    snapshot.sellers.filter((seller) => seller.uptime).length,
    firstRead,
  );

  now = 2 * MINUTE;
  requests = fakeIndex({ models: { a: sellers } });
  const second = await readIndex(first, () => now);
  assert.equal(count(requests, '/uptime'), 100 - firstRead);
  assert.ok(snapshotOf(second, now).sellers.every((seller) => seller.uptime));

  now = 4 * MINUTE;
  requests = fakeIndex({ models: { a: sellers } });
  const third = await readIndex(second, () => now);
  assert.equal(count(requests, '/uptime'), 0);

  now = DISCOVERY.uptimeRefreshMs;
  requests = fakeIndex({ models: { a: sellers } });
  await readIndex(third, () => now);
  assert.equal(count(requests, '/uptime'), firstRead);
});

void test('a failed uptime read keeps the last one', async () => {
  fakeIndex({ models: { a: ['n1'] } });
  const first = await readIndex(null, () => 0);
  fakeIndex({ models: { a: ['n1'] }, failUptime: new Set(['n1']) });
  const later = DISCOVERY.uptimeRefreshMs;
  const second = await readIndex(first, () => later);
  assert.ok(snapshotOf(second, later).sellers[0]?.uptime);
  assert.equal(second.uptimes.n1?.readAt, 0);
});

void test('a seller /network calls offline is not shown; without /network, the lists are', async () => {
  fakeIndex({ models: { a: ['n1', 'n2'] }, offline: ['n2'] });
  const withNetwork = snapshotOf(await readIndex(null, () => 0), 0);
  assert.deepEqual(
    withNetwork.sellers.map((seller) => seller.nodeId),
    ['n1'],
  );
  fakeIndex({ models: { a: ['n1', 'n2'] }, offline: null });
  const without = snapshotOf(await readIndex(null, () => 0), 0);
  assert.equal(without.network, null);
  assert.equal(without.sellers.length, 2);
});

void test('a failed run stores nothing; the last snapshot is shown as old once old, on every render', async () => {
  const { kv, stored } = fakeKv();
  fakeIndex({ models: { a: ['n1'] } });
  await refreshDiscovery(kv, () => 1000);
  const good = stored.get(STORED_KEY);
  fakeIndex({ models: { a: ['n1'] }, down: true });
  await assert.rejects(refreshDiscovery(kv, () => 1000 + 2 * MINUTE));
  assert.equal(stored.get(STORED_KEY), good);

  const before = await loadSnapshot(kv, 1000 + DISCOVERY.staleAfterMs);
  assert.equal(before.staleFrom, null);
  for (let step = 1; step <= 5; step += 1) {
    const late = await loadSnapshot(
      kv,
      1000 + DISCOVERY.staleAfterMs + step * DISCOVERY.reuseMs,
    );
    assert.equal(late.staleFrom, 1000);
    assert.equal(late.sellers.length, 1);
  }
});

void test('renders read KV, not the index, and reuse a recent KV read', async () => {
  const { kv, gets } = fakeKv();
  fakeIndex({ models: { a: ['n1'] } });
  const base = 10 * DISCOVERY.staleAfterMs;
  await refreshDiscovery(kv, () => base);
  const requests = fakeIndex({ models: { a: ['n1'] } });
  const getsBefore = gets();
  for (let render = 0; render < 50; render += 1)
    assert.equal((await loadSnapshot(kv, base + render)).sellers.length, 1);
  assert.equal(requests.length, 0);
  assert.equal(gets() - getsBefore, 1);
  await loadSnapshot(kv, base + DISCOVERY.reuseMs);
  assert.equal(gets() - getsBefore, 2);
});

void test('without a stored read, or with a failing KV, the index is unavailable', async () => {
  assert.equal(snapshotOf(null, 0).error, 'discovery not read yet');
  const failing: DiscoveryKv = {
    get: () => Promise.reject(new Error('kv down')),
    put: () => Promise.resolve(),
  };
  const snapshot = await loadSnapshot(failing, 100 * DISCOVERY.staleAfterMs);
  assert.equal(snapshot.error, 'kv down');
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

void test('the average 24 h uptime is over the sellers with an uptime read, and says how many', () => {
  const seller = (nodeId: string, ratio: number | null) => ({
    nodeId,
    owner: 'o',
    models: [],
    uptime:
      ratio === null ? null : { firstSeenAt: 1, windows: [{ days: 1, ratio }] },
  });
  const summary = summarizeOffers({
    generatedAt: 0,
    network: null,
    unreadModels: [],
    staleFrom: null,
    error: null,
    sellers: [seller('a', 1), seller('b', 0.5), seller('c', null)],
  });
  assert.equal(summary.dayUptimes, 2);
  assert.equal(summary.averageDayUptime, 0.75);
});
