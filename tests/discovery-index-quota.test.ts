// Protects the shared publication budget through public HTTP entries and both storage adapters.
// Synthetic signers and in-process requests exercise concurrent isolates without network access.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import {
  DISCOVERY_LIMITERS,
  PUBLISH_MODES,
} from '@gyblos/discovery-index/constants';
import {
  createMemoryStorage,
  type DiscoveryStorage,
} from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';

import { createSqliteD1 } from './support/d1-sqlite';
import {
  allLimiters,
  counting,
  HARNESS_KINDS,
  INDEX_ORIGIN,
  indexNode,
  T0,
} from './support/discovery-index-fixture';

function publishers(storage: DiscoveryStorage) {
  const clock = { now: T0 + 1000 };
  // Historical binding reproduces the pre-atomic quota, shared by both isolates.
  const legacy = { DISCOVERY_NODE_LIMITER: counting(10).limiter };
  const make = () =>
    createDiscoveryIndex({
      storage,
      publishers: { mode: PUBLISH_MODES.OPEN },
      limiters: { ...allLimiters(), ...legacy },
      now: () => clock.now,
    });
  const apps = [make(), make()];
  let next = 0;
  const publish = (record: unknown) =>
    apps[next++ % apps.length]!.fetch(
      new Request(`${INDEX_ORIGIN}/v1/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record }),
      }),
    );
  return { clock, publish };
}

for (const kind of HARNESS_KINDS) {
  void test(`${kind}: concurrent duplicate publications spend one shared NodeId allowance`, async () => {
    const database = kind === 'sqlite-d1' ? await createSqliteD1() : null;
    if (kind === 'sqlite-d1') assert.ok(database);
    const storage = database
      ? createD1Storage(database)
      : createMemoryStorage();
    let waiting = 0;
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wrapped: DiscoveryStorage = {
      ...storage,
      async put(entry) {
        if (entry.sequence === 2) {
          if (++waiting === 2) release();
          await ready;
        }
        return storage.put(entry);
      },
    };
    const { publish, clock } = publishers(wrapped);
    const seller = indexNode();
    const catalog = seller.catalog(1);
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
    for (let sequence = 3; sequence <= 10; sequence++)
      assert.equal(
        (await publish(await seller.presence(sequence, catalog))).status,
        201,
        `sequence ${sequence}`,
      );
    const refused = await publish(await seller.presence(11, catalog));
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '60');
    assert.deepEqual(await refused.json(), { error: 'RATE_LIMITED' });
    assert.equal((await storage.state(seller.nodeId))?.lastSequence, 10);
    assert.equal(
      (await publish(await seller.presence(10, catalog))).status,
      409,
    );
    assert.equal((await publish(indexNode().catalog(1))).status, 201);
    clock.now = Math.floor(clock.now / 60_000) * 60_000 + 60_000;
    assert.equal(
      (
        await publish(
          await seller.presence(11, catalog, { issuedAt: clock.now }),
        )
      ).status,
      201,
    );
  });

  void test(`${kind}: invalid catalog references spend no NodeId allowance`, async () => {
    const database = kind === 'sqlite-d1' ? await createSqliteD1() : null;
    if (kind === 'sqlite-d1') assert.ok(database);
    const storage = database
      ? createD1Storage(database)
      : createMemoryStorage();
    const { publish } = publishers(storage);
    const seller = indexNode();
    const catalog = seller.catalog(1);
    const unstored = seller.catalog(2);
    assert.equal((await publish(catalog)).status, 201);
    const invalid = await seller.presence(2, unstored);
    for (let attempt = 0; attempt < 12; attempt++)
      assert.equal((await publish(invalid)).status, 400);
    for (let sequence = 2; sequence <= 10; sequence++)
      assert.equal(
        (await publish(await seller.presence(sequence, catalog))).status,
        201,
      );
  });
}

void test('the Worker app requires only IP, publish and read limiters when NodeId quota is stored atomically', async () => {
  const all = allLimiters();
  const app = createDiscoveryIndex({
    storage: createMemoryStorage(),
    limiters: {
      [DISCOVERY_LIMITERS.IP]: all[DISCOVERY_LIMITERS.IP],
      [DISCOVERY_LIMITERS.PUBLISH]: all[DISCOVERY_LIMITERS.PUBLISH],
      [DISCOVERY_LIMITERS.READ]: all[DISCOVERY_LIMITERS.READ],
    },
  });
  assert.equal(
    (await app.fetch(new Request(`${INDEX_ORIGIN}/v1/health`))).status,
    200,
  );
});
