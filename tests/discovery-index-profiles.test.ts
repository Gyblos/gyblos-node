import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemorySellerProfileStore,
  sellerProfileTombstone,
  type SellerProfileStore,
} from '@gyblos/discovery-index/profile-store';
import { inviteHash } from '@gyblos/discovery-index/registrations';
import {
  PROFILE_CLAIM,
  verifyProfileClaim,
} from '@gyblos/protocol/profile-claim';

import {
  deny,
  expectError,
  indexNode,
} from './support/discovery-index-fixture';
import { HOUR, KINDS, NAME, profileHarness } from './support/profile-fixture';

for (const kind of KINDS) {
  void test(`seller profile (${kind}): a known seller sets a name that reads back signed and in the network`, async (context) => {
    const index = await profileHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    assert.deepEqual(await index.name(node), { ok: true, name: NAME });
    const response = await index.read(node.nodeId);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=10');
    const page = await response.json();
    const expected = await index.signed(node);
    assert.deepEqual(page, {
      nodeId: node.nodeId,
      name: NAME,
      issuedAt: index.clock.now,
      signature: expected.signature,
    });
    const rebuilt = await verifyProfileClaim({
      claim: {
        schemaVersion: PROFILE_CLAIM.schemaVersion,
        nodeId: page.nodeId,
        name: page.name,
        issuedAt: page.issuedAt,
      },
      signature: page.signature,
    });
    assert.equal(rebuilt.claim.name, NAME);
    const network = await index.network();
    assert.equal(network.nodes[0].nodeId, node.nodeId);
    assert.equal(network.nodes[0].name, NAME);
    assert.equal(network.nodes[0].github, null);
    assert.equal(network.truncated, false);
  });

  void test(`seller profile (${kind}): a rename wins, a clear keeps a tombstone and old claims are not replayed`, async (context) => {
    const index = await profileHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    const first = await index.signed(node);
    assert.equal((await index.post(first)).status, 200);
    await expectError(await index.post(first), 409, 'STALE_CLAIM');
    index.clock.now += 1;
    assert.deepEqual(await index.name(node, { name: 'Ada Byron' }), {
      ok: true,
      name: 'Ada Byron',
    });
    await expectError(await index.post(first), 409, 'STALE_CLAIM');
    index.clock.now += 1;
    assert.deepEqual(await index.name(node, { name: null }), {
      ok: true,
      name: null,
    });
    assert.deepEqual(
      await index.profiles.get(node.nodeId),
      sellerProfileTombstone(node.nodeId, index.clock.now),
    );
    await expectError(await index.read(node.nodeId), 404, 'NOT_FOUND');
    await expectError(await index.post(first), 409, 'STALE_CLAIM');
    assert.equal((await index.network()).nodes[0].name, null);
    index.clock.now += 1;
    assert.equal((await index.name(node, { name: 'Lab 42' })).name, 'Lab 42');
    assert.equal((await index.network()).nodes[0].name, 'Lab 42');
  });

  void test(`seller profile (${kind}): unknown, stale, future, forged, invalid and malformed claims are refused`, async (context) => {
    const index = await profileHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const now = index.clock.now;
    const stranger = indexNode();
    await expectError(
      await index.post(await index.signed(stranger)),
      403,
      'UNKNOWN_NODE',
    );
    assert.deepEqual(await index.name(stranger, { name: null }), {
      ok: true,
      name: null,
    });
    assert.equal(await index.profiles.get(stranger.nodeId), null);
    const node = indexNode();
    await index.publish(node);
    await expectError(
      await index.post(await index.signed(node, { issuedAt: now - 60_001 })),
      409,
      'STALE_CLAIM',
    );
    await expectError(
      await index.post(await index.signed(node, { issuedAt: now + 5001 })),
      400,
      'INVALID_CLAIM',
    );
    const good = await index.signed(node);
    await expectError(
      await index.post({ ...good, claim: { ...good.claim, name: 'Eve' } }),
      400,
      'INVALID_SIGNATURE',
    );
    const otherKey = await index.signed(stranger);
    await expectError(
      await index.post({ claim: good.claim, signature: otherKey.signature }),
      400,
      'INVALID_SIGNATURE',
    );
    for (const name of [
      'Ada ✓',
      '✅ Ada',
      'Gyblos',
      ' Ada',
      'Ada  Lovelace',
      `Ada${String.fromCodePoint(0x202e)}`,
      `Ad${String.fromCodePoint(0x200b)}a`,
      'x'.repeat(33),
      '',
    ])
      await expectError(
        await index.post({
          claim: { ...good.claim, name },
          signature: good.signature,
        }),
        400,
        'INVALID_CLAIM',
      );
    for (const body of ['{', '[]', { ...good, extra: 1 }])
      await expectError(await index.post(body), 400, 'INVALID_CLAIM');
    await expectError(
      await index.post(good, { 'Content-Type': 'text/plain' }),
      400,
      'INVALID_CLAIM',
    );
    await expectError(
      await index.post({ ...good, pad: 'x'.repeat(1100) }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    assert.equal(await index.profiles.get(node.nodeId), null);
  });

  void test(`seller profile (${kind}): a registered seller with no catalog may set a name; rate limits apply`, async (context) => {
    const limited = await profileHarness(kind, { limiter: deny });
    if (!limited) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    assert.equal((await limited.post(await limited.signed(node))).status, 429);
    const index = await profileHarness(kind);
    if (!index) return;
    const hash = await inviteHash('gyb_test');
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
    assert.deepEqual(await index.name(node), { ok: true, name: NAME });
    const listed = await index.network();
    assert.equal(listed.nodes[0].state, 'unpublished');
    assert.equal(listed.nodes[0].name, NAME);
  });

  void test(`seller profile (${kind}): reads refuse malformed NodeIds and query strings`, async (context) => {
    const index = await profileHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const nodeId = 'ab'.repeat(32);
    await expectError(await index.read(nodeId), 404, 'NOT_FOUND');
    for (const path of ['AB'.repeat(32), 'ab'.repeat(31), `${nodeId}?x=1`]) {
      const response = await index.read(path);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
      await expectError(response, 400, 'INVALID_QUERY');
    }
  });

  void test(`seller profile (${kind}): without a profile store both routes fail closed and the network lists no names`, async (context) => {
    const index = await profileHarness(kind, { noProfiles: true });
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    await expectError(
      await index.post(await index.signed(node)),
      503,
      'DISCOVERY_UNAVAILABLE',
    );
    await expectError(
      await index.read(node.nodeId),
      503,
      'DISCOVERY_UNAVAILABLE',
    );
    const network = await index.network();
    assert.equal(network.nodes[0].name, null);
    assert.equal(network.truncated, false);
  });

  void test(`seller profile (${kind}): a failed names read leaves every name null and the network truncated`, async (context) => {
    const failing: SellerProfileStore = {
      ...createMemorySellerProfileStore(),
      names: async () => {
        throw new Error('no such table');
      },
    };
    const index = await profileHarness(kind, { profiles: failing });
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    const network = await index.network();
    assert.equal(network.nodes[0].name, null);
    assert.equal(network.truncated, true);
  });
}
