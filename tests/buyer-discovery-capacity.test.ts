// The 64-candidate budget follows live signed availability, never the lifetime replay history.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { BUYER_DISCOVERY } from '@gyblos/buyer/constants';
import { discoverBuyerSellers } from '@gyblos/buyer/discovery';
import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { prepareConfiguredBuyerSelection } from '@gyblos/buyer/selection-runtime';
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';

import { discoveryResponse } from './support/buyer-discovery';
import {
  capacityNode,
  discoveryCapacityFixture,
} from './support/discovery-capacity';

void test('expiry releases capacity at the exact boundary without deleting replay history, including restart', async (t) => {
  const f = await discoveryCapacityFixture(t);
  f.rows[0]!.presenceExpiresAt = f.now() + 1;
  await f.write(f.rows);
  const state = await f.open();
  const before = await readFile(f.path, 'utf8');
  assert.equal(await state.observe(f.run.known), false);
  assert.equal(await readFile(f.path, 'utf8'), before);
  f.setNow(f.now() + 1);
  assert.equal(await state.observe(f.run.known), true);
  assert.equal((await f.saved()).rows.length, BUYER_DISCOVERY.openSellers + 1);
  const restarted = await f.open();
  assert.equal(
    await restarted.permits(
      f.run.catalog.owner,
      f.run.catalog.nodeId,
      f.run.request.params.catalogDigest,
      f.now(),
    ),
    true,
  );
  assert.equal(await restarted.observe(f.seller(100)), false);
});

void test('withdrawal releases a slot and its tombstone survives a restart', async (t) => {
  const f = await discoveryCapacityFixture(t);
  const state = await f.open();
  const old = f.seller(1);
  assert.equal(
    await state.observe({
      ...old,
      withdrawal: {
        schemaVersion: old.catalog.schemaVersion,
        kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
        owner: old.catalog.owner,
        nodeId: old.catalog.nodeId,
        sequence: old.presence!.sequence + 1,
        issuedAt: f.now(),
        expiresAt: old.presence!.expiresAt,
        catalogDigest: f.rows[0]!.catalogDigest,
      },
    }),
    false,
  );
  assert.equal(await state.observe(f.run.known), true);
  const restarted = await f.open();
  assert.equal(await restarted.observe(old), false);
  assert.equal(
    restarted.eligible(
      [{ owner: old.catalog.owner, nodeId: old.catalog.nodeId }],
      f.now(),
    ).length,
    0,
  );
  assert.equal((await f.saved()).rows.length, BUYER_DISCOVERY.openSellers + 1);
});

void test('conflict releases a slot without forgetting the conflicting sequence', async (t) => {
  const f = await discoveryCapacityFixture(t);
  const state = await f.open();
  const old = f.seller(1);
  assert.equal(
    await state.observe({
      ...old,
      presence: { ...old.presence!, issuedAt: old.presence!.issuedAt + 1 },
    }),
    false,
  );
  assert.equal(await state.observe(f.run.known), true);
  assert.equal(await (await f.open()).observe(old), false);
});

void test('capacity refusal is not cached as a registry denial; the same candidate succeeds immediately after expiry', async (t) => {
  const f = await discoveryCapacityFixture(t);
  f.rows[0]!.presenceExpiresAt = f.now() + 1;
  await f.write(f.rows);
  const state = await f.open();
  const config = {
    ...f.run.config,
    sellers: [],
    identity: { rpcUrl: 'https://rpc.test' },
    discovery: { ...f.run.config.discovery, open: true as const },
  };
  let checks = 0;
  const discover = () =>
    discoverBuyerSellers(config, state, {
      fetch: async () => discoveryResponse([f.run.entry]),
      now: f.now,
      openRelay: 'https://relay.test',
      verifyIdentity: async () => {
        checks++;
        return true;
      },
    });
  assert.deepEqual((await discover()).sellers, []);
  f.setNow(f.now() + 1);
  assert.equal((await discover()).sellers[0]?.nodeId, f.run.catalog.nodeId);
  assert.equal(checks, 2);
});

void test('buyer startup applies active admission with the original configured IDs', async (t) => {
  const f = await discoveryCapacityFixture(t);
  // No registry network is needed to check that the actual startup composes the bounded store.
  const config = {
    ...f.run.config,
    sellers: [],
    identity: { rpcUrl: 'https://rpc.invalid' },
    discovery: { ...f.run.config.discovery, open: true as const },
  };
  const prepared = await prepareConfiguredBuyerSelection(
    f.home.environment,
    config,
  );
  assert.ok(prepared.discovery);
  // Startup uses wall time; make all seeded metadata live at that clock too.
  const wall = Date.now();
  await f.write(
    f.rows.map((row) => ({
      ...row,
      catalogExpiresAt: wall + 60000,
      presenceExpiresAt: wall + 30000,
    })),
  );
  assert.equal(
    await prepared.discovery.observe({
      ...f.run.known,
      catalog: { ...f.run.catalog, expiresAt: wall + 60000 },
      presence: { ...f.run.known.presence!, expiresAt: wall + 30000 },
    }),
    false,
  );
});

void test('configured identities bypass only active capacity and the snapshot cannot be mutated by the caller', async (t) => {
  const f = await discoveryCapacityFixture(t);
  f.policy.configuredNodeIds.push(f.run.catalog.nodeId);
  const state = await f.open();
  f.policy.configuredNodeIds.push(capacityNode(100));
  assert.equal(await state.observe(f.run.known), true);
  assert.equal(await state.observe(f.seller(100)), false);
  assert.equal((await f.saved()).rows.length, BUYER_DISCOVERY.openSellers + 1);
});

void test('two handles cannot over-admit the last live slot and expected capacity does not poison the store', async (t) => {
  const f = await discoveryCapacityFixture(t, BUYER_DISCOVERY.openSellers - 1);
  const a = await f.open();
  const b = await f.open();
  const results = await Promise.allSettled([
    a.observe(f.run.known),
    b.observe(f.seller(100)),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled' && result.value)
      .length,
    1,
  );
  const restarted = await f.open();
  assert.equal(await restarted.observe(f.seller(101)), false);
  assert.equal(await restarted.observe(f.seller(1)), true);
});

void test('discovery history reserves configured space independently of active capacity', async (t) => {
  const f = await discoveryCapacityFixture(t, BUYER_DISCOVERY.maxStateRows - 1);
  await f.write(f.rows.map((row) => ({ ...row, presenceExpiresAt: 0 })));
  f.policy.configuredNodeIds.push(f.run.catalog.nodeId);
  const state = await f.open();
  assert.equal(await state.observe(f.seller(2000)), false);
  assert.equal(await state.observe(f.run.known), true);
  assert.equal(await state.observe(f.seller(2001)), false);
  assert.equal((await f.saved()).rows.length, BUYER_DISCOVERY.maxStateRows);
});

void test('preexisting excess live history has deterministic bounded eligibility, with floors intact', async (t) => {
  const f = await discoveryCapacityFixture(t, BUYER_DISCOVERY.openSellers + 1);
  const state = await f.open();
  const candidates = f.rows
    .map((row) => ({ nodeId: row.nodeId, owner: row.owner }))
    .reverse();
  const eligible = state.eligible(candidates, f.now());
  assert.equal(eligible.length, BUYER_DISCOVERY.openSellers);
  assert.equal(
    eligible.some(
      (seller) =>
        seller.nodeId === capacityNode(BUYER_DISCOVERY.openSellers + 1),
    ),
    false,
  );
  assert.equal(
    await state.permits(
      f.rows.at(-1)!.owner,
      f.rows.at(-1)!.nodeId,
      f.rows.at(-1)!.catalogDigest,
      f.now(),
    ),
    false,
  );
  assert.equal(
    await state.observe(f.seller(BUYER_DISCOVERY.openSellers + 1)),
    false,
  );
  assert.equal((await f.saved()).rows.length, BUYER_DISCOVERY.openSellers + 1);
});
