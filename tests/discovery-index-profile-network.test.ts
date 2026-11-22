import assert from 'node:assert/strict';
import test from 'node:test';

import { sellerProfileTombstone } from '@gyblos/discovery-index/profile-store';
import { createD1SellerProfileStore } from '@gyblos/discovery-index/profile-store-d1';
import { inviteHash } from '@gyblos/discovery-index/registrations';

import { createSqliteD1, type SqliteD1 } from './support/d1-sqlite';
import { expectError, indexNode } from './support/discovery-index-fixture';
import {
  HOUR,
  KINDS,
  NAME,
  profileHarness,
  storesOf,
} from './support/profile-fixture';

for (const kind of KINDS) {
  void test(`seller profile (${kind}): the network reads names only for the sellers it lists`, async (context) => {
    const made = await storesOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const signature = 'ab'.repeat(64);
    const strangers = Array.from({ length: 10_001 }, (_, index) => ({
      nodeId: index.toString(16).padStart(64, '0'),
      name: 'Zed',
      issuedAt: 1,
      signature,
      held: false as const,
    }));
    if (made.db) {
      made.db.raw.exec('BEGIN');
      const insert = made.db.raw.prepare(
        'INSERT INTO discovery_seller_profiles (node_id, name, issued_at, signature, held) VALUES (?, ?, ?, ?, 0)',
      );
      for (const row of strangers)
        insert.run(row.nodeId, row.name, row.issuedAt, row.signature);
      made.db.raw.exec('COMMIT');
    } else for (const row of strangers) await made.profiles.put(row);
    const index = await profileHarness(kind, { profiles: made.profiles });
    if (!index) return;
    const node = indexNode();
    await index.publish(node);
    await index.name(node);
    const network = await index.network();
    assert.equal(network.nodes.length, 1);
    assert.equal(network.nodes[0].name, NAME);
    assert.equal(network.truncated, false);
  });

  void test(`seller profile (${kind}): a name is not served once the index no longer knows the seller`, async (context) => {
    const index = await profileHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    const hash = await inviteHash('gyb_known');
    await index.registrations.createInvite({
      inviteHash: hash,
      contact: 'seller@example.com',
      createdAt: index.clock.now,
      expiresAt: index.clock.now + HOUR,
    });
    await index.registrations.redeem({
      inviteHash: hash,
      nodeId: node.nodeId,
      owner: 'owner',
      asset: 'asset',
      country: null,
      now: index.clock.now,
    });
    await index.name(node);
    assert.equal((await index.read(node.nodeId)).status, 200);
    index.revoked.add(node.nodeId);
    await expectError(await index.read(node.nodeId), 404, 'NO_PROFILE');
    assert.equal(
      (await index.network()).nodes.some(
        (listed: { nodeId: string }) => listed.nodeId === node.nodeId,
      ),
      false,
    );
  });

  void test(`seller profile (${kind}): a held name refuses the seller until the operator releases it`, async (context) => {
    const made = await storesOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const index = await profileHarness(kind, { profiles: made.profiles });
    if (!index) return;
    const node = indexNode();
    await index.publish(node);
    await index.name(node);
    await made.profiles.put(
      sellerProfileTombstone(node.nodeId, index.clock.now + 1, true),
    );
    index.clock.now += 2;
    await expectError(
      await index.post(await index.signed(node, { name: 'Again' })),
      403,
      'PROFILE_HELD',
    );
    assert.deepEqual(await index.name(node, { name: null }), {
      ok: true,
      name: null,
    });
    assert.equal((await made.profiles.get(node.nodeId))?.held, true);
    await expectError(await index.read(node.nodeId), 403, 'PROFILE_HELD');
    assert.equal((await index.network()).nodes[0].name, null);
  });

  void test(`seller profile (${kind}): the store keeps only the newest entry per NodeId and lists names by NodeId`, async (context) => {
    const made = await storesOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { profiles } = made;
    const [low, high] = ['01'.repeat(32), 'fe'.repeat(32)];
    const row = (nodeId: string, name: string, issuedAt: number) => ({
      nodeId,
      name,
      issuedAt,
      signature: 'ab'.repeat(64),
      held: false as const,
    });
    assert.equal(await profiles.put(row(high, 'Zed', 2)), true);
    assert.equal(await profiles.put(row(low, 'Amy', 2)), true);
    assert.equal(await profiles.put(row(low, 'Old', 2)), false);
    assert.equal(await profiles.put(row(low, 'Old', 1)), false);
    assert.deepEqual(await profiles.names([high, low, 'cd'.repeat(32)]), [
      { nodeId: low, name: 'Amy' },
      { nodeId: high, name: 'Zed' },
    ]);
    assert.deepEqual(await profiles.names([low]), [
      { nodeId: low, name: 'Amy' },
    ]);
    assert.deepEqual(await profiles.names([]), []);
    assert.equal(await profiles.put(sellerProfileTombstone(high, 3)), true);
    assert.equal(await profiles.put(row(high, 'Zed', 3)), false);
    assert.deepEqual(await profiles.names([low, high]), [
      { nodeId: low, name: 'Amy' },
    ]);
    const held = sellerProfileTombstone('ef'.repeat(32), 1, true);
    assert.equal(await profiles.put(held), true);
    assert.equal(await profiles.put(row(held.nodeId, 'New', 9)), false);
    assert.deepEqual(await profiles.get(held.nodeId), held);
    assert.deepEqual(await profiles.get(high), sellerProfileTombstone(high, 3));
    assert.deepEqual(await profiles.get(low), row(low, 'Amy', 2));
  });
}

void test('seller profile (sqlite-d1): a stored row with a name outside the rule fails closed', async (context) => {
  const db: SqliteD1 | null = await createSqliteD1();
  if (!db) return context.skip('node:sqlite unavailable');
  const nodeId = 'cd'.repeat(32);
  db.raw
    .prepare(
      'INSERT INTO discovery_seller_profiles (node_id, name, issued_at, signature) VALUES (?, ?, ?, ?)',
    )
    .run(nodeId, 'Ada ✓', 1, 'ab'.repeat(64));
  const profiles = createD1SellerProfileStore(db);
  await assert.rejects(profiles.get(nodeId), TypeError);
  await assert.rejects(profiles.names([nodeId]), TypeError);
});
