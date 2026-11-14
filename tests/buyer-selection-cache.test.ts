// Work a free buyer remembers between requests: a seller's verified catalog and presence while they stay
// current (the next request only asks for a quote), dropped after any failure; and a passed identity check
// for ten minutes, while a refusal is always checked again. Loopback control seller; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { createBuyerControlClient } from '@gyblos/buyer/control';
import { selectBuyerQuote } from '@gyblos/buyer/selection';
import {
  cachedIdentityCheck,
  createSnapshotCache,
} from '@gyblos/buyer/selection-cache';

import { selectionFixture } from './support/buyer-selection';

async function rig(t: test.TestContext) {
  const run = await selectionFixture();
  t.after(() => run.wire.close());
  const snapshots = createSnapshotCache();
  let failNext = false;
  let connects = 0;
  const dependencies = {
    ...run.dependencies,
    snapshots,
    // A fresh connection per request, as in production: nothing carries over but the cache.
    connect: async () => {
      connects++;
      const client = createBuyerControlClient(
        { ...run.wire.transport, remoteNodeId: run.catalog.nodeId },
        { ...run.trust(), now: run.context.now },
      );
      const original = client.requestOffer.bind(client);
      return Object.assign(client, {
        requestOffer: async (
          ...args: Parameters<typeof client.requestOffer>
        ) => {
          if (failNext) {
            failNext = false;
            throw new Error('Synthetic quote failure');
          }
          return original(...args);
        },
      });
    },
  };
  // Quote failures cool a seller down; these requests are about the cache, not the cooldown.
  const select = async () => {
    dependencies.stats.clear();
    return selectBuyerQuote(run.config, dependencies);
  };
  return {
    run,
    select,
    failOnce: () => {
      failNext = true;
    },
    connects: () => connects,
  };
}

void test('a seller verified on one request is only asked for a quote on the next', async (t) => {
  const host = await rig(t);
  assert.equal((await host.select()).ok, true);
  // Catalog, presence and quote.
  assert.equal(host.run.wire.queries, 3);
  assert.equal((await host.select()).ok, true);
  assert.equal(host.run.wire.queries, 4);
  assert.equal(host.connects(), 2);
});

void test('a failed quote drops the remembered snapshot, so the next request verifies again', async (t) => {
  const host = await rig(t);
  assert.equal((await host.select()).ok, true);
  host.failOnce();
  assert.equal((await host.select()).ok, false);
  const before = host.run.wire.queries;
  assert.equal((await host.select()).ok, true);
  assert.equal(host.run.wire.queries - before, 3);
});

void test('a snapshot about to expire, or under a withdrawal, is not used', () => {
  const cache = createSnapshotCache();
  const seller = {
    owner: 'o',
    nodeId: 'n',
    relayUrl: null,
    directAddresses: [],
  };
  const known = (expiresAt: number) =>
    ({
      catalog: { expiresAt: 10_000_000 },
      presence: { expiresAt },
      withdrawal: null,
    }) as never;
  const signed = {} as never;
  cache.set(seller, known(BUYER_SELECTION.snapshotMarginMs + 1001), signed);
  assert.ok(cache.get(seller, 1000));
  assert.equal(cache.get(seller, 1001), undefined);
  cache.set(seller, known(1_000_000), signed);
  assert.equal(
    cache.get({ ...seller, withdrawal: {} as never }, 1000),
    undefined,
  );
  assert.ok(cache.get({ ...seller, owner: 'o' }, 1000));
  assert.equal(cache.get({ ...seller, owner: 'other' }, 1000), undefined);
});

void test('a passed identity check is reused for ten minutes; a refusal never is', async () => {
  let clock = 0;
  const answers = [true, false, true, true];
  const asked: string[] = [];
  const verify = cachedIdentityCheck(
    async (subject: { nodeId: string; owner: string }) => {
      asked.push(subject.nodeId);
      return { ok: answers.shift()! };
    },
    () => clock,
  );
  const good = { nodeId: 'a', owner: 'o' };
  assert.equal((await verify(good)).ok, true);
  assert.equal((await verify(good)).ok, true);
  assert.deepEqual(asked, ['a']);
  const bad = { nodeId: 'b', owner: 'o' };
  assert.equal((await verify(bad)).ok, false);
  assert.equal((await verify(bad)).ok, true);
  assert.deepEqual(asked, ['a', 'b', 'b']);
  clock = BUYER_SELECTION.identityCacheMs;
  assert.equal((await verify(good)).ok, true);
  assert.deepEqual(asked, ['a', 'b', 'b', 'a']);
});
