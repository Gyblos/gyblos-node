// Work a free buyer remembers between requests: a seller's verified catalog and presence while they stay
// current (the next request only asks for a quote), dropped after any failure. Identity checks are never
// remembered. Loopback control seller; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION } from '@gyblos/buyer/constants';
import { createBuyerControlClient } from '@gyblos/buyer/control';
import { selectBuyerQuote } from '@gyblos/buyer/selection';
import { createSnapshotCache } from '@gyblos/buyer/selection-cache';
import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { controlFail } from '@gyblos/protocol/control-validation';

import { selectionFixture } from './support/buyer-selection';

async function rig(t: test.TestContext) {
  const run = await selectionFixture();
  t.after(() => run.wire.close());
  const snapshots = createSnapshotCache();
  let failNext = false;
  let staleNext = false;
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
          if (staleNext) {
            staleNext = false;
            controlFail(CONTROL_CODES.STALE);
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
    staleOnce: () => {
      staleNext = true;
    },
    dependencies,
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

void test('any refusal of a quote for a remembered catalog is asked again fresh in the same request', async (t) => {
  const host = await rig(t);
  assert.equal((await host.select()).ok, true);
  host.failOnce();
  const before = host.run.wire.queries;
  assert.equal((await host.select()).ok, true);
  // The synthetic refusal is local: then catalog, presence and quote on a fresh snapshot.
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

void test('a seller that replaced its catalog is asked again in the same request, not cooled down', async (t) => {
  const host = await rig(t);
  assert.equal((await host.select()).ok, true);
  host.staleOnce();
  const before = host.run.wire.queries;
  const result = await selectBuyerQuote(host.run.config, host.dependencies);
  assert.equal(result.ok, true);
  // The refused quote was not sent (the synthetic refusal is local), then catalog, presence and quote.
  assert.equal(host.run.wire.queries - before, 3);
  const seller = host.run.config.sellers[0]!.nodeId;
  assert.equal(
    host.dependencies.stats.get(seller)?.cooldownUntil ?? null,
    null,
  );
});
