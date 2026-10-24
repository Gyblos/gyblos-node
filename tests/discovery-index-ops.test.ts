// Protects discovery index operations: fail-closed 503s, development limits only on loopback, static
// errors with no logging, real 404s, caps, throttled index-driven pruning and the Worker entry.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import {
  DISCOVERY_INDEX_LIMITS,
  DISCOVERY_LIMITERS,
  PUBLISH_MODES,
} from '@gyblos/discovery-index/constants';
import { ipKey } from '@gyblos/discovery-index/ip-key';
import type { DiscoveryPublishers } from '@gyblos/discovery-index/publishers';
import {
  createMemoryStorage,
  type DiscoveryStorage,
} from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { createWorker } from '@gyblos/discovery-index/worker';

import {
  createSqliteD1,
  namedParams,
  namedSql,
  type SqliteStatement,
} from './support/d1-sqlite.js';
import {
  allLimiters,
  CLIENT_IP,
  eachStorage,
  expectError,
  INDEX_ORIGIN,
  INDEX_OWNER,
  indexNode,
  T0,
} from './support/discovery-index-fixture.js';

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request(`${INDEX_ORIGIN}/v1/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
const json = (value: unknown) => JSON.stringify({ record: value });
const open: DiscoveryPublishers = { mode: PUBLISH_MODES.OPEN };

void test('missing storage or limiter bindings fail closed with 503', async () => {
  const storage = createMemoryStorage();
  const variants = [
    { limiters: allLimiters() },
    ...Object.values(DISCOVERY_LIMITERS).map((name) => {
      const limiters: Record<string, unknown> = { ...allLimiters() };
      delete limiters[name];
      return { storage, limiters };
    }),
  ];
  for (const options of variants) {
    const app = createDiscoveryIndex({
      ...options,
      now: () => T0,
      publishers: open,
    });
    for (const request of [
      new Request(`${INDEX_ORIGIN}/v1/health`),
      new Request(`${INDEX_ORIGIN}/v1/sellers?model=a`),
      new Request(`${INDEX_ORIGIN}/unknown`),
      post('{}'),
    ]) {
      const response = await app.fetch(request);
      assert.equal(response.status, 503, request.url);
      assert.deepEqual(await response.json(), {
        error: 'DISCOVERY_UNAVAILABLE',
      });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-robots-tag'), 'noindex');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  }
});

void test('development relaxes only limiters, only on loopback, never storage', async () => {
  const storage = createMemoryStorage();
  const local = createDiscoveryIndex({
    development: true,
    storage,
    now: () => T0,
  });
  assert.equal(
    (await local.fetch(new Request('http://localhost/v1/health'))).status,
    200,
  );
  assert.equal(
    (await local.fetch(new Request('http://127.0.0.1/v1/health'))).status,
    200,
  );
  assert.equal(
    (await local.fetch(new Request(`${INDEX_ORIGIN}/v1/health`))).status,
    503,
  );
  const noStorage = createDiscoveryIndex({ development: true, now: () => T0 });
  assert.equal(
    (await noStorage.fetch(new Request('http://localhost/v1/health'))).status,
    503,
  );
  const production = createDiscoveryIndex({ storage, now: () => T0 });
  assert.equal(
    (await production.fetch(new Request('https://localhost/v1/health'))).status,
    503,
  );
});

void test('storage failures return a static 503 and nothing is logged', async () => {
  const failing = new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error(`secret detail ${CLIENT_IP}`);
      },
    },
  ) as DiscoveryStorage;
  const app = createDiscoveryIndex({
    storage: failing,
    limiters: allLimiters(),
    now: () => T0 + 1000,
    publishers: open,
  });
  const seller = indexNode();
  const logged: unknown[][] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  for (const key of Object.keys(original) as (keyof typeof original)[])
    console[key] = (...args: unknown[]) => void logged.push(args);
  try {
    for (const request of [
      new Request(`${INDEX_ORIGIN}/v1/health`),
      new Request(`${INDEX_ORIGIN}/v1/sellers?model=a`),
      post(json(seller.catalog(1)), { 'CF-Connecting-IP': CLIENT_IP }),
    ]) {
      const response = await app.fetch(request);
      assert.equal(response.status, 503);
      assert.equal(await response.text(), '{"error":"DISCOVERY_UNAVAILABLE"}');
    }
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, []);
});

void test('unknown paths and methods are real 404s with noindex', async () => {
  const app = createDiscoveryIndex({
    storage: createMemoryStorage(),
    limiters: allLimiters(),
    now: () => T0,
  });
  for (const [path, method] of [
    ['/', 'GET'],
    ['/v1', 'GET'],
    ['/unknown', 'GET'],
    ['/v1/records', 'GET'],
    ['/v1/sellers', 'POST'],
    ['/v1/records/x', 'POST'],
    ['/api/v1/discovery/health', 'GET'],
  ]) {
    const response = await app.fetch(
      new Request(INDEX_ORIGIN + path, { method }),
    );
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
    assert.equal(response.headers.get('x-robots-tag'), 'noindex');
  }
});

void test('the GET limit is capped at 200 rows', async () => {
  const storage = createMemoryStorage();
  const seen: number[] = [];
  const spy: DiscoveryStorage = {
    ...storage,
    list: async (query) => {
      seen.push(query.limit);
      return storage.list(query);
    },
  };
  const app = createDiscoveryIndex({
    storage: spy,
    limiters: allLimiters(),
    now: () => T0,
  });
  const response = await app.fetch(
    new Request(`${INDEX_ORIGIN}/v1/sellers?model=a&limit=5000`),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [201]);
});

void test('response size is capped and paging continues from the last included seller', async () => {
  const app = createDiscoveryIndex({
    storage: createMemoryStorage(),
    limiters: allLimiters(),
    now: () => T0 + 1000,
    publishers: open,
    maxResponseBytes: 2500,
  });
  for (let i = 0; i < 3; i++) {
    const seller = indexNode();
    const catalog = seller.catalog(1);
    for (const signed of [catalog, await seller.presence(2, catalog)])
      assert.equal((await app.fetch(post(json(signed)))).status, 201);
  }
  const first = await app.fetch(
    new Request(`${INDEX_ORIGIN}/v1/sellers?model=qwen3-0.6b`),
  );
  const text = await first.text();
  const body = JSON.parse(text);
  assert.ok(new TextEncoder().encode(text).byteLength <= 2500);
  assert.ok(body.sellers.length >= 1 && body.sellers.length < 3);
  assert.match(body.next, /^\d+-[0-9a-f]{64}$/);
});

void test('publish body cap fits a maximal 32 KiB record plus envelope headroom', async () => {
  assert.equal(DISCOVERY_INDEX_LIMITS.maxBodyBytes, 34_816);
  const app = createDiscoveryIndex({
    storage: createMemoryStorage(),
    limiters: allLimiters(),
    now: () => T0 + 1000,
    publishers: open,
  });
  const response = await app.fetch(post(json({ pad: 'x'.repeat(34_816) })));
  await expectError(response, 413, 'PAYLOAD_TOO_LARGE');
});

eachStorage(
  'new NodeIds beyond the node cap are rate limited; known NodeIds still publish',
  async ({ publish }) => {
    const first = indexNode();
    const catalog = first.catalog(1);
    assert.equal((await publish(catalog)).status, 201);
    assert.equal((await publish(indexNode().catalog(1))).status, 201);
    await expectError(
      await publish(indexNode().catalog(1)),
      429,
      'RATE_LIMITED',
    );
    assert.equal((await publish(await first.presence(2, catalog))).status, 201);
  },
  { maxNodes: 2 },
);

void test('pruning is throttled per app and runs again after the interval', async () => {
  const storage = createMemoryStorage();
  let prunes = 0;
  const spy: DiscoveryStorage = {
    ...storage,
    prune: async (now) => {
      prunes++;
      return storage.prune(now);
    },
  };
  const clock = { now: T0 + 1000 };
  const app = createDiscoveryIndex({
    storage: spy,
    limiters: allLimiters(),
    now: () => clock.now,
    publishers: open,
  });
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await app.fetch(post(json(indexNode().catalog(1))))).status,
      201,
    );
  assert.equal(prunes, 1);
  clock.now = T0 + 1000 + DISCOVERY_INDEX_LIMITS.pruneIntervalMs;
  const later = indexNode().catalog(1, { issuedAt: clock.now });
  assert.equal((await app.fetch(post(json(later)))).status, 201);
  assert.equal(prunes, 2);
});

void test('D1 prune uses indexes only and drops expired rows by key', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const recorded: SqliteStatement[] = [];
  const recording = {
    ...db,
    batch: (statements: Parameters<typeof db.batch>[0]) => {
      for (const statement of statements)
        recorded.push(statement as SqliteStatement);
      return db.batch(statements);
    },
  };
  const storage = createD1Storage(recording);
  const put = (
    nodeId: string,
    expiresAt: number,
    retainUntil: number,
    models: string[],
  ) =>
    storage.put({
      kind: 'catalog',
      nodeId,
      owner: INDEX_OWNER,
      sequence: 1,
      issuedAt: T0,
      expiresAt,
      digest: 'd'.repeat(64),
      models,
      signature: 's',
      retainUntil,
      json: '{}',
    });
  await put('a'.repeat(64), T0 + 600_000, T0 + 1_200_000, ['m1']);
  await put('b'.repeat(64), T0 + 10, T0 + 20, ['m1', 'm2']);
  recorded.length = 0;
  await storage.prune(T0 + 100);
  assert.ok(recorded.length > 0);
  for (const statement of recorded) {
    const plan = db.raw
      .prepare('EXPLAIN QUERY PLAN ' + namedSql(statement.sql))
      .all(namedParams(statement.params));
    for (const step of plan)
      assert.doesNotMatch(String(step.detail), /^SCAN /, statement.sql);
    assert.doesNotMatch(statement.sql, /NOT IN/);
  }
  const models = db.raw
    .prepare(
      'SELECT node_id AS n, model_id AS m FROM discovery_catalog_models ORDER BY n, m',
    )
    .all()
    .map((row) => `${String(row.n)[0]}:${String(row.m)}`);
  assert.deepEqual(models, ['a:m1']);
  assert.equal(await storage.nodeCount(), 1);
});

void test('ipKey keys IPv4 by full address and IPv6 by /64 prefix', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0DB8:0001:0002:ffff::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
  assert.equal(ipKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.equal(ipKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64');
  assert.notEqual(ipKey('2001:db8:1:3::1'), ipKey('2001:db8:1:2::1'));
  assert.equal(ipKey(undefined), 'local');
  assert.equal(ipKey('not-an-ip'), 'not-an-ip');
});

void test('the Worker entry fails closed without bindings and serves health with them', async (context) => {
  const worker = createWorker();
  const health = new Request(`${INDEX_ORIGIN}/v1/health`);
  for (const bindings of [
    {},
    undefined,
    { DISCOVERY_DB: {}, ...allLimiters() },
  ]) {
    const response = await worker.fetch(health.clone(), bindings);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'DISCOVERY_UNAVAILABLE' });
  }
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const bindings = { DISCOVERY_DB: db, ...allLimiters() };
  const response = await worker.fetch(health.clone(), bindings);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    records: 0,
    publish: 'closed',
  });
  // Loopback hosts get no development relaxation from the Worker entry.
  const local = await worker.fetch(new Request('https://localhost/v1/health'), {
    DISCOVERY_DB: db,
  });
  assert.equal(local.status, 503);
});
