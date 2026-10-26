// Protects the discovery index publish allowlist: parsing of the Worker secret, fail-closed publishing,
// the cheap 403 before signature, storage and per-NodeId limits, open mode and public reads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import {
  DISCOVERY_DB_BINDING,
  DISCOVERY_LIMITERS,
  DISCOVERY_PUBLISH_ALLOWLIST_BINDING,
  PUBLISH_ALLOWLIST,
  PUBLISH_MODES,
} from '@gyblos/discovery-index/constants';
import {
  parsePublishAllowlist,
  type DiscoveryPublishers,
} from '@gyblos/discovery-index/publishers';
import {
  createMemoryStorage,
  type DiscoveryStorage,
} from '@gyblos/discovery-index/storage';
import { createWorker } from '@gyblos/discovery-index/worker';

import { createSqliteD1 } from './support/d1-sqlite.js';
import {
  allLimiters,
  allow,
  CLIENT_IP,
  counting,
  eachStorage,
  expectError,
  INDEX_ORIGIN,
  indexNode,
  MODEL,
  T0,
  type FakeLimiter,
} from './support/discovery-index-fixture.js';

const post = (signed: unknown) =>
  new Request(`${INDEX_ORIGIN}/v1/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': CLIENT_IP,
    },
    body: JSON.stringify({ record: signed }),
  });
const sellersRequest = () =>
  new Request(`${INDEX_ORIGIN}/v1/sellers?model=${MODEL}`);
const healthRequest = () => new Request(`${INDEX_ORIGIN}/v1/health`);
const hex = (digit: string) => digit.repeat(64);
const allowlist = (...nodeIds: string[]): DiscoveryPublishers => ({
  mode: PUBLISH_MODES.ALLOWLIST,
  nodeIds: new Set(nodeIds),
});

// Counts every storage call, so a rejection can be shown to never touch storage.
function countingStorage(storage: DiscoveryStorage) {
  const calls: string[] = [];
  const counted: DiscoveryStorage = {
    state: (nodeId) => (calls.push('state'), storage.state(nodeId)),
    put: (entry) => (calls.push('put'), storage.put(entry)),
    list: (query) => (calls.push('list'), storage.list(query)),
    count: (now) => (calls.push('count'), storage.count(now)),
    nodeCount: () => (calls.push('nodeCount'), storage.nodeCount()),
    prune: (now) => (calls.push('prune'), storage.prune(now)),
  };
  return { storage: counted, calls };
}

void test('the allowlist secret parses NodeIds, whitespace around commas and the open value', () => {
  const [a, b] = [hex('a'), hex('b')];
  assert.deepEqual(parsePublishAllowlist('*'), { mode: PUBLISH_MODES.OPEN });
  assert.deepEqual(parsePublishAllowlist(' * \n'), {
    mode: PUBLISH_MODES.OPEN,
  });
  assert.deepEqual(parsePublishAllowlist(a), allowlist(a));
  assert.deepEqual(parsePublishAllowlist(` ${a} ,\t${b}\n`), allowlist(a, b));
  assert.deepEqual(parsePublishAllowlist(`${a},${a}`), allowlist(a));
  const full = Array.from({ length: PUBLISH_ALLOWLIST.maxEntries }, (_, i) =>
    i.toString(16).padStart(64, '0'),
  );
  const parsed = parsePublishAllowlist(full.join(','));
  assert.equal(parsed?.mode, PUBLISH_MODES.ALLOWLIST);
});

void test('a missing, empty, malformed or oversized allowlist parses to closed', () => {
  const a = hex('a');
  const oversized = Array.from(
    { length: PUBLISH_ALLOWLIST.maxEntries + 1 },
    (_, i) => i.toString(16).padStart(64, '0'),
  ).join(',');
  for (const value of [
    undefined,
    null,
    42,
    {},
    [a],
    '',
    '   ',
    ',',
    `${a},`,
    `,${a}`,
    `${a},,${hex('b')}`,
    a.toUpperCase(),
    a.slice(1),
    `${a}0`,
    `0x${a.slice(2)}`,
    `${a};${hex('b')}`,
    `${a} ${hex('b')}`,
    `*,${a}`,
    '**',
    oversized,
  ])
    assert.equal(parsePublishAllowlist(value), undefined, String(value));
});

const allowed = indexNode();

eachStorage(
  'an allowlisted NodeId publishes and is listed',
  async ({ publish, sellers }) => {
    const catalog = allowed.catalog(1);
    assert.equal((await publish(catalog)).status, 201);
    assert.equal(
      (await publish(await allowed.presence(2, catalog))).status,
      201,
    );
    assert.equal((await sellers()).body.sellers.length, 1);
  },
  { publishers: allowlist(hex('c'), allowed.nodeId) },
);

void test('a NodeId outside the allowlist gets 403 before signature, storage or the NodeId limit', async () => {
  const { storage, calls } = countingStorage(createMemoryStorage());
  const node = counting(100);
  const ip = counting(100);
  const publishLimiter = counting(100);
  const app = createDiscoveryIndex({
    storage,
    limiters: {
      [DISCOVERY_LIMITERS.IP]: ip.limiter,
      [DISCOVERY_LIMITERS.PUBLISH]: publishLimiter.limiter,
      [DISCOVERY_LIMITERS.NODE]: node.limiter,
      [DISCOVERY_LIMITERS.READ]: allow,
    },
    now: () => T0 + 1000,
    publishers: allowlist(allowed.nodeId),
  });
  const stranger = indexNode();
  const signed = stranger.catalog(1);
  // A bad signature still gets 403: the allowlist is checked before verification.
  const forged = { ...signed, signature: 'f'.repeat(128) };
  for (const record of [signed, forged]) {
    const response = await app.fetch(post(record));
    await expectError(response, 403, 'PUBLISH_NOT_ALLOWED');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, []);
  assert.equal(node.counts.size, 0);
  // The per-IP limits still apply first, as for every publish.
  assert.equal(ip.counts.get(CLIENT_IP), 2);
  assert.equal(publishLimiter.counts.get(CLIENT_IP), 2);
  // Strict body checks still come first.
  const junk = new Request(`${INDEX_ORIGIN}/v1/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"record":1,"record":2}',
  });
  await expectError(await app.fetch(junk), 400, 'INVALID_RECORD');
  assert.deepEqual(calls, []);
  assert.equal(node.counts.size, 0);
});

void test('without publishers every publish is 503 while reads keep working', async () => {
  const { storage, calls } = countingStorage(createMemoryStorage());
  const app = createDiscoveryIndex({
    storage,
    limiters: allLimiters(),
    now: () => T0 + 1000,
  });
  for (const body of [
    allowed.catalog(1),
    { pad: 'x'.repeat(40_000) },
    'not a record',
  ])
    await expectError(
      await app.fetch(post(body)),
      503,
      'DISCOVERY_UNAVAILABLE',
    );
  assert.deepEqual(calls, []);
  const listed = await app.fetch(sellersRequest());
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('access-control-allow-origin'), '*');
  const health = await app.fetch(healthRequest());
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    records: 0,
    publish: 'closed',
  });
});

void test('open publishers accept any self-signed NodeId and health reports the mode', async () => {
  const app = createDiscoveryIndex({
    storage: createMemoryStorage(),
    limiters: allLimiters(),
    now: () => T0 + 1000,
    publishers: { mode: PUBLISH_MODES.OPEN },
  });
  assert.equal((await app.fetch(post(indexNode().catalog(1)))).status, 201);
  assert.deepEqual(await (await app.fetch(healthRequest())).json(), {
    ok: true,
    records: 1,
    publish: 'open',
  });
  const restricted = createDiscoveryIndex({
    storage: createMemoryStorage(),
    limiters: allLimiters(),
    now: () => T0 + 1000,
    publishers: allowlist(allowed.nodeId),
  });
  const health = await (await restricted.fetch(healthRequest())).text();
  assert.equal(health, '{"ok":true,"records":0,"publish":"allowlist"}');
  assert.ok(!health.includes(allowed.nodeId));
});

void test('the Worker maps the allowlist secret: absent, empty, malformed, open and listed', async (context) => {
  const db = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const limiters: Record<string, FakeLimiter> = allLimiters(allow);
  // The Worker uses the wall clock, so these records are issued now.
  const live = { issuedAt: Date.now() };
  const base = { [DISCOVERY_DB_BINDING]: db, ...limiters };
  const closed = [
    base,
    { ...base, [DISCOVERY_PUBLISH_ALLOWLIST_BINDING]: '' },
    { ...base, [DISCOVERY_PUBLISH_ALLOWLIST_BINDING]: `${allowed.nodeId},` },
    { ...base, [DISCOVERY_PUBLISH_ALLOWLIST_BINDING]: 7 },
  ];
  for (const bindings of closed) {
    const worker = createWorker();
    await expectError(
      await worker.fetch(post(allowed.catalog(1, live)), bindings),
      503,
      'DISCOVERY_UNAVAILABLE',
    );
    assert.equal((await worker.fetch(sellersRequest(), bindings)).status, 200);
    assert.deepEqual(
      await (await worker.fetch(healthRequest(), bindings)).json(),
      {
        ok: true,
        records: 0,
        publish: 'closed',
      },
    );
  }
  const listed = createWorker();
  const listedBindings = {
    ...base,
    [DISCOVERY_PUBLISH_ALLOWLIST_BINDING]: ` ${hex('d')} , ${allowed.nodeId} `,
  };
  assert.equal(
    (await listed.fetch(post(allowed.catalog(1, live)), listedBindings)).status,
    201,
  );
  await expectError(
    await listed.fetch(post(indexNode().catalog(1, live)), listedBindings),
    403,
    'PUBLISH_NOT_ALLOWED',
  );
  const open = createWorker();
  const openBindings = { ...base, [DISCOVERY_PUBLISH_ALLOWLIST_BINDING]: '*' };
  assert.equal(
    (await open.fetch(post(indexNode().catalog(1, live)), openBindings)).status,
    201,
  );
  assert.equal(
    (await (await open.fetch(healthRequest(), openBindings)).json()).publish,
    'open',
  );
});
