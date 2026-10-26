// Protects the discovery index edge behavior: HTTPS-only requests, the GET /v1/sellers response
// cache (normalized keys, 200s only, fail-open) and the per-app health count cache.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDiscoveryIndex,
  type DiscoveryIndexOptions,
  type ResponseCache,
} from '@gyblos/discovery-index/app';
import {
  DISCOVERY_LIMITERS,
  PUBLISH_MODES,
} from '@gyblos/discovery-index/constants';
import {
  createMemoryStorage,
  type DiscoveryStorage,
} from '@gyblos/discovery-index/storage';
import { createWorker } from '@gyblos/discovery-index/worker';

import { createSqliteD1 } from './support/d1-sqlite.js';
import {
  allLimiters,
  CLIENT_IP,
  counting,
  deny,
  expectError,
  INDEX_ORIGIN,
  indexNode,
  memoryCache,
  MODEL,
  T0,
} from './support/discovery-index-fixture.js';

const HTTP_ORIGIN = 'http://discovery.gyblos.com';

const post = (origin: string, signed: unknown) =>
  new Request(`${origin}/v1/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': CLIENT_IP,
    },
    body: JSON.stringify({ record: signed }),
  });

// Counts storage calls by method name.
function spiedStorage(storage: DiscoveryStorage = createMemoryStorage()) {
  const calls: string[] = [];
  const spied = new Proxy(storage, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.push(String(name));
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { storage: spied, calls };
}

function indexApp(options: DiscoveryIndexOptions = {}) {
  const clock = { now: T0 + 1000 };
  const app = createDiscoveryIndex({
    storage: createMemoryStorage(),
    limiters: allLimiters(),
    now: () => clock.now,
    publishers: { mode: PUBLISH_MODES.OPEN },
    ...options,
  });
  return { app, clock };
}

async function publishSeller(
  app: ReturnType<typeof indexApp>['app'],
  issuedAt = T0,
) {
  const seller = indexNode();
  const catalog = seller.catalog(1, { issuedAt });
  assert.equal((await app.fetch(post(INDEX_ORIGIN, catalog))).status, 201);
  const presence = await seller.presence(2, catalog, { issuedAt });
  assert.equal((await app.fetch(post(INDEX_ORIGIN, presence))).status, 201);
  return seller;
}

void test('non-HTTPS requests get a static 400 HTTPS_REQUIRED before storage or limits', async () => {
  const { storage, calls } = spiedStorage();
  const limiter = counting(1000);
  const { app } = indexApp({ storage, limiters: allLimiters(limiter.limiter) });
  const requests = [
    new Request(`${HTTP_ORIGIN}/v1/health`),
    new Request(`${HTTP_ORIGIN}/v1/sellers?model=${MODEL}`),
    new Request(`${HTTP_ORIGIN}/v1/sellers?model=${MODEL}`, { method: 'HEAD' }),
    new Request(`${HTTP_ORIGIN}/unknown`),
    post(HTTP_ORIGIN, indexNode().catalog(1)),
  ];
  for (const request of requests) {
    const response = await app.fetch(request);
    assert.equal(response.status, 400, `${request.method} ${request.url}`);
    if (request.method !== 'HEAD')
      assert.equal(await response.text(), '{"error":"HTTPS_REQUIRED"}');
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.deepEqual(calls, []);
  assert.equal(limiter.counts.size, 0);
  // HTTPS is checked first, even when the index is unavailable.
  const unavailable = createDiscoveryIndex({ now: () => T0 });
  await expectError(
    await unavailable.fetch(new Request(`${HTTP_ORIGIN}/v1/health`)),
    400,
    'HTTPS_REQUIRED',
  );
});

void test('loopback http is allowed only for a development app', async () => {
  const storage = createMemoryStorage();
  const development = createDiscoveryIndex({
    development: true,
    storage,
    now: () => T0,
  });
  assert.equal(
    (await development.fetch(new Request('http://localhost/v1/health'))).status,
    200,
  );
  assert.equal(
    (await development.fetch(new Request('http://[::1]/v1/health'))).status,
    200,
  );
  await expectError(
    await development.fetch(new Request(`${HTTP_ORIGIN}/v1/health`)),
    400,
    'HTTPS_REQUIRED',
  );
  const production = createDiscoveryIndex({
    storage,
    limiters: allLimiters(),
    now: () => T0,
  });
  await expectError(
    await production.fetch(new Request('http://localhost/v1/health')),
    400,
    'HTTPS_REQUIRED',
  );
  assert.equal(
    (await production.fetch(new Request('https://localhost/v1/health'))).status,
    200,
  );
});

void test('GET /v1/sellers is served from the response cache under a normalized key', async () => {
  const { storage, calls } = spiedStorage();
  const edge = memoryCache();
  const { app } = indexApp({ storage, cache: edge.cache });
  await publishSeller(app);
  calls.length = 0;
  const first = await app.fetch(
    new Request(`${INDEX_ORIGIN}/v1/sellers?model=${MODEL}`),
  );
  assert.equal(first.status, 200);
  const text = await first.text();
  const key = `${INDEX_ORIGIN}/v1/sellers?limit=50&model=${MODEL}`;
  assert.deepEqual(edge.puts, [key]);
  assert.equal(
    edge.entries.get(key)?.headers.get('cache-control'),
    'public, max-age=10',
  );
  assert.deepEqual(calls, ['list']);
  for (const query of [`model=${MODEL}`, `limit=50&model=${MODEL}`]) {
    const again = await app.fetch(
      new Request(`${INDEX_ORIGIN}/v1/sellers?${query}`),
    );
    assert.equal(again.status, 200);
    assert.equal(await again.text(), text);
    assert.equal(again.headers.get('cache-control'), 'public, max-age=10');
    assert.equal(
      again.headers.get('content-type'),
      'application/json; charset=UTF-8',
    );
    assert.equal(again.headers.get('access-control-allow-origin'), '*');
    assert.equal(again.headers.get('x-robots-tag'), 'noindex');
    assert.equal(again.headers.get('x-content-type-options'), 'nosniff');
  }
  assert.deepEqual(calls, ['list']);
  assert.deepEqual(edge.puts, [key]);
  // The effective limit and the cursor are part of the key; parameter order is not.
  const cursor = `${T0}-${'a'.repeat(64)}`;
  await app.fetch(
    new Request(
      `${INDEX_ORIGIN}/v1/sellers?limit=5000&cursor=${cursor}&model=${MODEL}`,
    ),
  );
  await app.fetch(
    new Request(
      `${INDEX_ORIGIN}/v1/sellers?model=${MODEL}&cursor=${cursor}&limit=200`,
    ),
  );
  assert.deepEqual(edge.puts, [
    key,
    `${INDEX_ORIGIN}/v1/sellers?cursor=${cursor}&limit=200&model=${MODEL}`,
  ]);
});

void test('only 200 sellers pages are cached: errors, other routes and POST never are', async () => {
  const edge = memoryCache();
  const failing: DiscoveryStorage = {
    ...createMemoryStorage(),
    list: async () => {
      throw new Error('storage down');
    },
  };
  const { app } = indexApp({ storage: failing, cache: edge.cache });
  await expectError(
    await app.fetch(new Request(`${INDEX_ORIGIN}/v1/sellers?model=`)),
    400,
    'INVALID_QUERY',
  );
  await expectError(
    await app.fetch(new Request(`${INDEX_ORIGIN}/v1/sellers?model=a&x=1`)),
    400,
    'INVALID_QUERY',
  );
  await expectError(
    await app.fetch(new Request(`${INDEX_ORIGIN}/v1/sellers?model=a`)),
    503,
    'DISCOVERY_UNAVAILABLE',
  );
  const { app: limited } = indexApp({
    cache: edge.cache,
    limiters: { ...allLimiters(), [DISCOVERY_LIMITERS.IP]: deny },
  });
  await expectError(
    await limited.fetch(new Request(`${INDEX_ORIGIN}/v1/sellers?model=a`)),
    429,
    'RATE_LIMITED',
  );
  const { app: healthy } = indexApp({ cache: edge.cache });
  assert.equal(
    (await healthy.fetch(post(INDEX_ORIGIN, indexNode().catalog(1)))).status,
    201,
  );
  assert.equal(
    (await healthy.fetch(new Request(`${INDEX_ORIGIN}/v1/health`))).status,
    200,
  );
  assert.deepEqual(edge.puts, []);
});

// The edge can rewrite a stored entry's Cache-Control (for example the zone's Browser Cache TTL
// turned max-age=10 into 14400 in production), so a hit must re-assert the sellers policy.
void test('a cache hit is served with the sellers Cache-Control, not the stored one', async () => {
  const edge = memoryCache();
  const { app } = indexApp({ cache: edge.cache });
  await publishSeller(app);
  const url = `${INDEX_ORIGIN}/v1/sellers?model=${MODEL}`;
  assert.equal((await app.fetch(new Request(url))).status, 200);
  const key = `${INDEX_ORIGIN}/v1/sellers?limit=50&model=${MODEL}`;
  const stored = edge.entries.get(key);
  assert.ok(stored);
  const rewritten = new Response(await stored.clone().text(), stored);
  rewritten.headers.set('cache-control', 'public, max-age=14400');
  rewritten.headers.set('expires', 'Sat, 24 Oct 2026 18:00:00 GMT');
  edge.entries.set(key, rewritten);
  const hit = await app.fetch(new Request(url));
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('cache-control'), 'public, max-age=10');
  assert.equal(hit.headers.get('expires'), null);
});

void test('a failing response cache fails open to storage', async () => {
  const { storage, calls } = spiedStorage();
  const broken: ResponseCache = {
    match: async () => {
      throw new Error('cache down');
    },
    put: async () => {
      throw new Error('cache down');
    },
  };
  const { app } = indexApp({ storage, cache: broken });
  await publishSeller(app);
  for (let i = 0; i < 2; i++) {
    const response = await app.fetch(
      new Request(`${INDEX_ORIGIN}/v1/sellers?model=${MODEL}`),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sellers.length, 1);
  }
  assert.equal(calls.filter((name) => name === 'list').length, 2);
});

void test('health caches the record count for 30 s per app and recounts after a publish', async () => {
  const { storage, calls } = spiedStorage();
  const { app, clock } = indexApp({ storage });
  const health = async () =>
    (await app.fetch(new Request(`${INDEX_ORIGIN}/v1/health`))).json();
  const counts = () => calls.filter((name) => name === 'count').length;
  assert.deepEqual(await health(), { ok: true, records: 0, publish: 'open' });
  clock.now += 29_999;
  assert.deepEqual(await health(), { ok: true, records: 0, publish: 'open' });
  assert.equal(counts(), 1);
  clock.now += 1;
  await health();
  assert.equal(counts(), 2);
  assert.equal(
    (
      await app.fetch(
        post(INDEX_ORIGIN, indexNode().catalog(1, { issuedAt: clock.now })),
      )
    ).status,
    201,
  );
  assert.deepEqual(await health(), { ok: true, records: 1, publish: 'open' });
  assert.equal(counts(), 3);
  const { app: allowlisted } = indexApp({
    publishers: { mode: PUBLISH_MODES.ALLOWLIST, nodeIds: new Set() },
  });
  assert.equal(
    await (
      await allowlisted.fetch(new Request(`${INDEX_ORIGIN}/v1/health`))
    ).text(),
    '{"ok":true,"records":0,"publish":"allowlist"}',
  );
});

void test('the Worker uses caches.default when present and works without it', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const bindings = { DISCOVERY_DB: db, ...allLimiters() };
  const request = () =>
    new Request(`${INDEX_ORIGIN}/v1/sellers?model=${MODEL}`);
  const plain = await createWorker().fetch(request(), bindings);
  assert.equal(plain.status, 200);
  const edge = memoryCache();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    value: { default: edge.cache },
    configurable: true,
    writable: true,
  });
  try {
    const worker = createWorker();
    assert.equal((await worker.fetch(request(), bindings)).status, 200);
    assert.equal((await worker.fetch(request(), bindings)).status, 200);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'caches', previous);
    else Reflect.deleteProperty(globalThis, 'caches');
  }
  assert.deepEqual(edge.puts, [
    `${INDEX_ORIGIN}/v1/sellers?limit=50&model=${MODEL}`,
  ]);
  assert.equal(edge.matches.length, 2);
  // Plain http never reaches the Worker's app.
  await expectError(
    await createWorker().fetch(
      new Request(`${HTTP_ORIGIN}/v1/health`),
      bindings,
    ),
    400,
    'HTTPS_REQUIRED',
  );
});
