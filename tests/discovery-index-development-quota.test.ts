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
      const make = () =>
        createDiscoveryIndex({
          storage,
          development,
          limiters: allLimiters(),
          now: () => T0 + 1000,
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
    });
