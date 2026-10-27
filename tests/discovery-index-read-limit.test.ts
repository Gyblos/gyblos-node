// Protects the global read limiter on both storage adapters: it guards storage reads only (sellers
// cache misses and stale health counts), shares one budget across cursors and clients, and its
// 429 is never cached. Synthetic keys only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { DISCOVERY_LIMITERS } from '@gyblos/discovery-index/constants';

import {
  counting,
  deny,
  expectError,
  HARNESS_KINDS,
  indexHarness,
  indexNode,
  memoryCache,
  MODEL,
  type IndexHarness,
} from './support/discovery-index-fixture.js';

// Pinned literal, not READ_LIMIT_KEY, so a changed key fails here.
const READ_KEY = 'global';

// One case per storage adapter, each with its own response cache.
function eachCachedStorage(
  title: string,
  run: (
    harness: IndexHarness,
    edge: ReturnType<typeof memoryCache>,
  ) => Promise<void>,
) {
  for (const kind of HARNESS_KINDS)
    void test(`${kind}: ${title}`, async (context) => {
      const edge = memoryCache();
      const harness = await indexHarness(kind, { cache: edge.cache });
      if (!harness) {
        context.skip('node:sqlite unavailable');
        return;
      }
      await run(harness, edge);
    });
}

async function publishSeller({ publish, clock }: IndexHarness) {
  const seller = indexNode();
  const catalog = seller.catalog(1, { issuedAt: clock.now });
  assert.equal((await publish(catalog)).status, 201);
  const presence = await seller.presence(2, catalog, { issuedAt: clock.now });
  assert.equal((await publish(presence)).status, 201);
}

eachCachedStorage(
  'a sellers cache hit does not consume the read limit',
  async (harness) => {
    await publishSeller(harness);
    const read = counting(1000);
    const limiters = { [DISCOVERY_LIMITERS.READ]: read.limiter };
    for (let i = 0; i < 3; i++) {
      const response = await harness.call(
        `/v1/sellers?model=${MODEL}`,
        {},
        limiters,
      );
      assert.equal(response.status, 200);
    }
    assert.deepEqual([...read.counts], [[READ_KEY, 1]]);
  },
);

eachCachedStorage(
  'a sellers miss over the read limit is 429 no-store and never cached',
  async (harness, edge) => {
    await publishSeller(harness);
    const read = counting(1);
    const limiters = { [DISCOVERY_LIMITERS.READ]: read.limiter };
    const first = `/v1/sellers?model=${MODEL}`;
    assert.equal((await harness.call(first, {}, limiters)).status, 200);
    const limited = await harness.call(
      `/v1/sellers?model=${MODEL}&limit=5`,
      {},
      limiters,
    );
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    await expectError(limited, 429, 'RATE_LIMITED');
    assert.equal(edge.puts.length, 1);
    // The cached page is still served while the read budget is spent.
    assert.equal((await harness.call(first, {}, limiters)).status, 200);
    // A failing read limiter fails closed on a miss.
    await expectError(
      await harness.call(
        `/v1/sellers?model=${MODEL}&limit=7`,
        {},
        {
          [DISCOVERY_LIMITERS.READ]: deny,
        },
      ),
      429,
      'RATE_LIMITED',
    );
    assert.equal(edge.puts.length, 1);
  },
);

eachCachedStorage(
  'different cursors and clients share one global read budget',
  async (harness) => {
    const read = counting(2);
    const limiters = { [DISCOVERY_LIMITERS.READ]: read.limiter };
    const statuses: number[] = [];
    for (const [i, ip] of [
      '203.0.113.1',
      '203.0.113.2',
      '2001:db8::1',
    ].entries()) {
      const cursor = `${i + 1}-${'a'.repeat(64)}`;
      const response = await harness.call(
        `/v1/sellers?model=${MODEL}&cursor=${cursor}`,
        { headers: { 'CF-Connecting-IP': ip } },
        limiters,
      );
      statuses.push(response.status);
    }
    assert.deepEqual(statuses, [200, 200, 429]);
    assert.deepEqual([...read.counts], [[READ_KEY, 3]]);
  },
);

eachCachedStorage(
  'health consumes the read limit only when its count is stale',
  async ({ call, clock }) => {
    const read = counting(1000);
    const counted = { [DISCOVERY_LIMITERS.READ]: read.limiter };
    const denied = { [DISCOVERY_LIMITERS.READ]: deny };
    assert.equal((await call('/v1/health', {}, counted)).status, 200);
    clock.now += 29_999;
    assert.equal((await call('/v1/health', {}, counted)).status, 200);
    // A fresh count needs no storage read, so an exhausted budget does not matter.
    assert.equal((await call('/v1/health', {}, denied)).status, 200);
    assert.deepEqual([...read.counts], [[READ_KEY, 1]]);
    clock.now += 1;
    const limited = await call('/v1/health', {}, denied);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    assert.equal(limited.headers.get('retry-after'), '60');
    await expectError(limited, 429, 'RATE_LIMITED');
    assert.equal((await call('/v1/health', {}, counted)).status, 200);
    assert.deepEqual([...read.counts], [[READ_KEY, 2]]);
  },
);

eachCachedStorage(
  'HEAD reads follow the same read limit as GET',
  async (harness, edge) => {
    await publishSeller(harness);
    const read = counting(1);
    const limiters = { [DISCOVERY_LIMITERS.READ]: read.limiter };
    const head = { method: 'HEAD' };
    const path = `/v1/sellers?model=${MODEL}`;
    assert.equal((await harness.call(path, head, limiters)).status, 200);
    assert.equal((await harness.call(path, head, limiters)).status, 200);
    assert.deepEqual([...read.counts], [[READ_KEY, 1]]);
    const limited = await harness.call(`${path}&limit=5`, head, limiters);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('cache-control'), 'no-store');
    assert.equal(edge.puts.length, 1);
    const health = await harness.call('/v1/health', head, limiters);
    assert.equal(health.status, 429);
  },
);

eachCachedStorage(
  'an accepted publish makes the next health read consume the read limit',
  async (harness) => {
    const read = counting(1000);
    const limiters = { [DISCOVERY_LIMITERS.READ]: read.limiter };
    assert.equal((await harness.call('/v1/health', {}, limiters)).status, 200);
    await publishSeller(harness);
    const health = await harness.call('/v1/health', {}, limiters);
    assert.equal((await health.json()).records, 2);
    assert.deepEqual([...read.counts], [[READ_KEY, 2]]);
  },
);
