import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_DISCOVERY } from '@gyblos/buyer/constants';
import { prepareConfiguredBuyerSelection } from '@gyblos/buyer/selection-runtime';
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';

import { discoveryCapacityFixture } from './support/discovery-capacity';

const identities = (rows: { owner: string; nodeId: string }[]) =>
  rows.map(({ owner, nodeId }) => ({ owner, nodeId }));

void test('open discovery admits every live verified seller, well beyond 64', async (t) => {
  const f = await discoveryCapacityFixture(t, 200);
  const state = await f.open();
  assert.equal(state.eligible(identities(f.rows), f.now()).length, 200);
  assert.equal(await state.observe(f.run.known), true);
  const known = { owner: f.run.catalog.owner, nodeId: f.run.catalog.nodeId };
  assert.equal(state.eligible([known], f.now()).length, 1);
  assert.equal((await f.saved()).rows.length, 201);
});

void test('expiry ends eligibility without deleting replay history, including restart', async (t) => {
  const f = await discoveryCapacityFixture(t);
  f.rows[0]!.presenceExpiresAt = f.now() + 1;
  await f.write(f.rows);
  const state = await f.open();
  assert.equal(state.eligible(identities(f.rows), f.now()).length, 4);
  f.setNow(f.now() + 1);
  assert.equal(state.eligible(identities(f.rows), f.now()).length, 3);
  assert.equal((await f.saved()).rows.length, 4);
});

void test('a withdrawal ends eligibility and its tombstone survives a restart', async (t) => {
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
  const restarted = await f.open();
  assert.equal(await restarted.observe(old), false);
  const withdrawn = { owner: old.catalog.owner, nodeId: old.catalog.nodeId };
  assert.equal(restarted.eligible([withdrawn], f.now()).length, 0);
  assert.equal((await f.saved()).rows.length, 4);
});

void test('a conflict ends eligibility without forgetting the conflicting sequence', async (t) => {
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
  const reopened = await f.open();
  assert.equal(await reopened.observe(old), false);
  const conflicted = { owner: old.catalog.owner, nodeId: old.catalog.nodeId };
  assert.equal(reopened.eligible([conflicted], f.now()).length, 0);
});

void test('a full history refuses new open sellers but keeps room for configured ones', async (t) => {
  const f = await discoveryCapacityFixture(t, BUYER_DISCOVERY.maxStateRows - 1);
  await f.write(f.rows.map((row) => ({ ...row, presenceExpiresAt: 0 })));
  f.policy.configuredNodeIds.push(f.run.catalog.nodeId);
  const state = await f.open();
  assert.equal(await state.observe(f.seller(2000)), false);
  assert.equal(await state.observe(f.run.known), true);
  assert.equal(await state.observe(f.seller(2001)), false);
  assert.equal(await state.observe(f.seller(1)), true);
  assert.equal((await f.saved()).rows.length, BUYER_DISCOVERY.maxStateRows);
});

void test('two handles cannot overfill the last history row', async (t) => {
  const f = await discoveryCapacityFixture(t, BUYER_DISCOVERY.maxStateRows - 1);
  const a = await f.open();
  const b = await f.open();
  const results = await Promise.allSettled([
    a.observe(f.run.known),
    b.observe(f.seller(2000)),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled' && result.value)
      .length,
    1,
  );
  const restarted = await f.open();
  assert.equal(await restarted.observe(f.seller(2001)), false);
  assert.equal((await f.saved()).rows.length, BUYER_DISCOVERY.maxStateRows);
});

void test('buyer startup applies open admission with the original configured IDs', async (t) => {
  const f = await discoveryCapacityFixture(t, BUYER_DISCOVERY.maxStateRows);
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
  const wall = Date.now();
  assert.equal(
    await prepared.discovery.observe({
      ...f.run.known,
      catalog: { ...f.run.catalog, expiresAt: wall + 60000 },
      presence: { ...f.run.known.presence!, expiresAt: wall + 30000 },
    }),
    false,
  );
});
