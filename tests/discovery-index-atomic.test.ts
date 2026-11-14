// Protects withdrawal retention and concurrent discovery publication through the public HTTP app.
// Uses synthetic signers, a fake clock and both storage adapters; no external services.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { PUBLISH_MODES } from '@gyblos/discovery-index/constants';
import {
  createMemoryStorage,
  type DiscoveryStorage,
} from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';

import { createSqliteD1 } from './support/d1-sqlite';
import {
  allLimiters,
  HARNESS_KINDS,
  INDEX_ORIGIN,
  indexNode,
  MODEL,
  T0,
  type HarnessKind,
} from './support/discovery-index-fixture';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function storageFor(kind: HarnessKind) {
  if (kind === 'memory') return createMemoryStorage();
  const database = await createSqliteD1();
  assert.ok(database, 'node:sqlite is required for the D1 regression');
  return createD1Storage(database);
}

function harness(storage: DiscoveryStorage, maxNodes = 10_000) {
  const clock = { now: T0 + 1000 };
  const app = createDiscoveryIndex({
    storage,
    publishers: { mode: PUBLISH_MODES.OPEN },
    limiters: allLimiters(),
    now: () => clock.now,
    maxNodes,
  });
  const publish = (record: unknown) =>
    app.fetch(
      new Request(`${INDEX_ORIGIN}/v1/records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record }),
      }),
    );
  const sellers = () =>
    app.fetch(new Request(`${INDEX_ORIGIN}/v1/sellers?model=${MODEL}`));
  return { clock, publish, sellers };
}

for (const kind of HARNESS_KINDS) {
  void test(`${kind}: pruning a short withdrawal never revives its live catalog`, async () => {
    const storage = await storageFor(kind);
    const { clock, publish, sellers } = harness(storage);
    const seller = indexNode();
    const catalog = seller.catalog(1);
    assert.equal((await publish(catalog)).status, 201);
    assert.equal(
      (await publish(await seller.presence(2, catalog))).status,
      201,
    );
    const withdrawal = await seller.withdrawal(3, catalog);
    assert.equal(
      (
        await publish(
          seller.sign({ ...withdrawal.record, expiresAt: T0 + 10_000 }),
        )
      ).status,
      201,
    );
    clock.now = T0 + 61_000;
    assert.equal(
      (await publish(indexNode().catalog(1, { issuedAt: clock.now }))).status,
      201,
    );
    const response = await publish(
      await seller.presence(4, catalog, { issuedAt: clock.now }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'UNKNOWN_CATALOG' });
    assert.equal((await storage.state(seller.nodeId))?.lastSequence, 3);
    const page: unknown = await (await sellers()).json();
    assert.deepEqual(page, { sellers: [], next: null, generatedAt: clock.now });
  });

  for (const recordKind of [
    PUBLIC_RECORD_KINDS.PRESENCE,
    PUBLIC_RECORD_KINDS.WITHDRAWAL,
  ]) {
    void test(`${kind}: a concurrent catalog replacement rejects an old ${recordKind} without advancing sequence`, async () => {
      const storage = await storageFor(kind);
      const started = deferred();
      const release = deferred();
      const wrapped: DiscoveryStorage = {
        ...storage,
        async put(entry) {
          if (entry.kind === recordKind && entry.sequence === 4) {
            started.resolve();
            await release.promise;
          }
          return storage.put(entry);
        },
      };
      const { publish } = harness(wrapped);
      const seller = indexNode();
      const first = seller.catalog(1);
      assert.equal((await publish(first)).status, 201);
      const pending = publish(
        recordKind === PUBLIC_RECORD_KINDS.PRESENCE
          ? await seller.presence(4, first)
          : await seller.withdrawal(4, first),
      );
      await started.promise;
      const replacement = seller.catalog(3);
      try {
        assert.equal((await publish(replacement)).status, 201);
      } finally {
        release.resolve();
      }
      const rejected = await pending;
      assert.equal(rejected.status, 400);
      assert.deepEqual(await rejected.json(), { error: 'UNKNOWN_CATALOG' });
      assert.equal((await storage.state(seller.nodeId))?.lastSequence, 3);
      assert.equal(
        (await publish(await seller.presence(5, replacement))).status,
        201,
      );
    });
  }

  void test(`${kind}: concurrent new publishers cannot share the final capacity slot`, async () => {
    const storage = await storageFor(kind);
    const bothReady = deferred();
    let waiting = 0;
    const wrapped: DiscoveryStorage = {
      ...storage,
      async put(entry) {
        waiting++;
        if (waiting === 2) bothReady.resolve();
        await bothReady.promise;
        return storage.put(entry);
      },
    };
    const { publish } = harness(wrapped, 1);
    const first = indexNode();
    const second = indexNode();
    const responses = await Promise.all([
      publish(first.catalog(1)),
      publish(second.catalog(1)),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [201, 429],
    );
    const states = await Promise.all([
      storage.state(first.nodeId),
      storage.state(second.nodeId),
    ]);
    assert.equal(states.filter(Boolean).length, 1);
  });
}
