// Accepted presence concurrency, retention edges and permanent metadata bounds for public uptime.
// Both public storage adapters run with signed synthetic publishers and isolated temporary homes.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createMemoryStorage,
  type DiscoveryStorage,
} from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import { UPTIME, uptimePage } from '@gyblos/discovery-index/uptime';

import { createSqliteD1 } from './support/d1-sqlite';
import {
  HARNESS_KINDS,
  indexHarness,
  indexNode,
  T0,
  type HarnessKind,
} from './support/discovery-index-fixture';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function storageFor(kind: HarnessKind, context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'index-uptime-regression-'));
  const originalDirectory = process.cwd();
  const originalHome = process.env.GYBLOS_HOME;
  const originalLabHome = process.env.GYBLOS_LAB_HOME;
  process.chdir(directory);
  process.env.GYBLOS_HOME = join(directory, 'product');
  process.env.GYBLOS_LAB_HOME = join(directory, 'lab');
  context.after(async () => {
    process.chdir(originalDirectory);
    if (originalHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = originalHome;
    if (originalLabHome === undefined) delete process.env.GYBLOS_LAB_HOME;
    else process.env.GYBLOS_LAB_HOME = originalLabHome;
    await rm(directory, { recursive: true, force: true });
  });
  if (kind === HARNESS_KINDS[0]) return createMemoryStorage();
  const database = await createSqliteD1();
  if (!database) {
    context.skip('node:sqlite unavailable');
    return undefined;
  }
  context.after(() => database.raw.close());
  return createD1Storage(database);
}

function windowsAt(seen: number, slots: number, ratio: number) {
  return UPTIME.windowDays.map((days) => ({ days, seen, slots, ratio }));
}

for (const kind of HARNESS_KINDS) {
  void test(`${kind}: accepted presences completing out of order retain the earliest sighting and slot`, async (context) => {
    const base = await storageFor(kind, context);
    if (!base) return;
    const first = T0 + UPTIME.slotMs - 1;
    const later = first + 2;
    const held = deferred();
    const entered = deferred();
    const laterWritten = deferred();
    const storage: DiscoveryStorage = {
      ...base,
      async markSeen(nodeId, now) {
        if (now === first) {
          entered.resolve();
          await held.promise;
        }
        await base.markSeen(nodeId, now);
        if (now === later) laterWritten.resolve();
      },
    };
    const harness = await indexHarness('memory', { storage });
    assert.ok(harness);
    harness.clock.now = first;
    const seller = indexNode();
    const catalog = seller.catalog(1, { issuedAt: first });
    assert.equal((await harness.publish(catalog)).status, 201);
    const initial = harness.publish(
      await seller.presence(2, catalog, { issuedAt: first }),
    );
    await entered.promise;
    harness.clock.now = later;
    const next = harness.publish(
      await seller.presence(3, catalog, { issuedAt: later }),
    );
    try {
      // Permit either storage-level minima or per-node serialization to enforce the invariant.
      await Promise.race([
        laterWritten.promise,
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    } finally {
      held.resolve();
    }
    assert.deepEqual(
      (await Promise.all([initial, next])).map((response) => response.status),
      [201, 201],
    );
    harness.clock.now = T0 + 3 * UPTIME.slotMs + 1;
    const response = await harness.call(`/v1/uptime?node=${seller.nodeId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      nodeId: seller.nodeId,
      firstSeenAt: first,
      lastSeenAt: later,
      slotMs: UPTIME.slotMs,
      windows: windowsAt(2, 4, 0.5),
      generatedAt: harness.clock.now,
    });
  });

}
