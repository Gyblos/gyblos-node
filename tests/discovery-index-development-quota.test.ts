// Protects the original loopback-only development allowance through the public HTTP app.
// Both adapters share atomic quota state across app instances; inputs cannot choose their budget.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import {
  DEVELOPMENT_LIMITS,
  NODE_PUBLISH_QUOTA,
  PUBLISH_MODES,
} from '@gyblos/discovery-index/constants';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';

import { createSqliteD1 } from './support/d1-sqlite';
import {
  allLimiters,
  HARNESS_KINDS,
  indexNode,
  T0,
} from './support/discovery-index-fixture';

const origins = [
  {
    origin: 'http://127.0.0.1',
    development: true,
    limit: DEVELOPMENT_LIMITS.perMinute,
  },
  {
    origin: 'https://localhost',
    development: true,
    limit: DEVELOPMENT_LIMITS.perMinute,
  },
  {
    origin: 'http://[::1]',
    development: true,
    limit: DEVELOPMENT_LIMITS.perMinute,
  },
  {
    origin: 'https://127.0.0.1',
    development: false,
    limit: NODE_PUBLISH_QUOTA.limit,
  },
  {
    origin: 'https://index.example',
    development: true,
    limit: NODE_PUBLISH_QUOTA.limit,
  },
  {
    origin: 'https://localhost.example',
    development: true,
    limit: NODE_PUBLISH_QUOTA.limit,
  },
] as const;

for (const kind of HARNESS_KINDS)
  for (const { origin, development, limit } of origins)
    void test(`${kind}: development=${development} quota at ${origin} is ${limit}`, async () => {
      const database = kind === 'sqlite-d1' ? await createSqliteD1() : null;
      if (kind === 'sqlite-d1') assert.ok(database);
      const storage = database
        ? createD1Storage(database)
        : createMemoryStorage();
      const clock = { now: T0 + 1000 };
      const make = () =>
        createDiscoveryIndex({
          storage,
          development,
          limiters: allLimiters(),
          now: () => clock.now,
          publishers: { mode: PUBLISH_MODES.OPEN },
        });
      const apps = [make(), make()];
      const seller = indexNode();
      const catalog = seller.catalog(1);
      const publish = (record: unknown, sequence: number) =>
        apps[sequence % 2]!.fetch(
          new Request(origin + '/v1/records', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              // Rotate only IP to keep the distinct middleware allowance from masking the NodeId quota.
              'CF-Connecting-IP': `203.0.113.${sequence}`,
              Host: 'localhost',
              'X-Forwarded-Host': 'localhost',
            },
            body: JSON.stringify({ record }),
          }),
        );
      assert.equal((await publish(catalog, 1)).status, 201);
      for (let sequence = 2; sequence <= limit; sequence++)
        assert.equal(
          (await publish(await seller.presence(sequence, catalog), sequence))
            .status,
          201,
          `sequence ${sequence}`,
        );
      const extra = await publish(
        await seller.presence(limit + 1, catalog),
        limit + 1,
      );
      assert.equal(extra.status, 429);
      assert.deepEqual(await extra.json(), { error: 'RATE_LIMITED' });
      assert.equal((await storage.state(seller.nodeId))?.lastSequence, limit);
      clock.now += 60_000;
      assert.equal(
        (
          await publish(
            await seller.presence(limit + 1, catalog, {
              issuedAt: clock.now,
            }),
            limit + 1,
          )
        ).status,
        201,
      );
    });

for (const kind of HARNESS_KINDS)
  void test(`${kind}: duplicate local development publications spend one shared allowance`, async () => {
    const database = kind === 'sqlite-d1' ? await createSqliteD1() : null;
    if (kind === 'sqlite-d1') assert.ok(database);
    const storage = database
      ? createD1Storage(database)
      : createMemoryStorage();
    let release = () => {};
    let waiting = 0;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shared = {
      ...storage,
      async put(entry: Parameters<typeof storage.put>[0]) {
        if (entry.sequence === 2) {
          if (++waiting === 2) release();
          await ready;
        }
        return storage.put(entry);
      },
    };
    const make = () =>
      createDiscoveryIndex({
        storage: shared,
        development: true,
        now: () => T0 + 1000,
        publishers: { mode: PUBLISH_MODES.OPEN },
      });
    const apps = [make(), make()];
    const seller = indexNode();
    const catalog = seller.catalog(1);
    let request = 0;
    const publish = (record: unknown) => {
      request++;
      return apps[request % 2]!.fetch(
        new Request('http://127.0.0.1/v1/records', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'CF-Connecting-IP': `203.0.113.${request}`,
          },
          body: JSON.stringify({ record }),
        }),
      );
    };
    assert.equal((await publish(catalog)).status, 201);
    const duplicate = await seller.presence(2, catalog);
    const responses = await Promise.all([
      publish(duplicate),
      publish(duplicate),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 409],
    );
    for (let sequence = 3; sequence <= DEVELOPMENT_LIMITS.perMinute; sequence++)
      assert.equal(
        (await publish(await seller.presence(sequence, catalog))).status,
        201,
      );
    assert.equal(
      (
        await publish(
          await seller.presence(DEVELOPMENT_LIMITS.perMinute + 1, catalog),
        )
      ).status,
      429,
    );
    assert.equal(
      (await storage.state(seller.nodeId))?.lastSequence,
      DEVELOPMENT_LIMITS.perMinute,
    );
  });
