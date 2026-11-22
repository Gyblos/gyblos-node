import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryIndex } from '@gyblos/discovery-index/app';
import { PUBLISH_MODES } from '@gyblos/discovery-index/constants';
import {
  createMemorySellerProfileStore,
  sellerProfileTombstone,
  type SellerProfileStore,
} from '@gyblos/discovery-index/profile-store';
import { createD1SellerProfileStore } from '@gyblos/discovery-index/profile-store-d1';
import {
  createMemoryRegistrationStore,
  type RegistrationStore,
} from '@gyblos/discovery-index/registration-store';
import { createD1RegistrationStore } from '@gyblos/discovery-index/registration-store-d1';
import { inviteHash } from '@gyblos/discovery-index/registrations';
import { createMemoryStorage } from '@gyblos/discovery-index/storage';
import { createD1Storage } from '@gyblos/discovery-index/storage-d1';
import {
  PROFILE_CLAIM,
  signProfileClaim,
  verifyProfileClaim,
  type ProfileClaimV1,
} from '@gyblos/protocol/profile-claim';

import { createSqliteD1, type SqliteD1 } from './support/d1-sqlite';
import {
  allLimiters,
  deny,
  expectError,
  INDEX_ORIGIN,
  indexNode,
  T0,
  type FakeLimiter,
  type IndexNode,
} from './support/discovery-index-fixture';

const KINDS = ['memory', 'sqlite-d1'] as const;
type Kind = (typeof KINDS)[number];
const HOUR = 3_600_000;
const NAME = 'Ada Lovelace';

async function storesOf(kind: Kind) {
  if (kind === 'memory')
    return {
      db: null,
      profiles: createMemorySellerProfileStore(),
      registrations: createMemoryRegistrationStore(),
    };
  const db = await createSqliteD1();
  if (!db) return null;
  return {
    db,
    profiles: createD1SellerProfileStore(db),
    registrations: createD1RegistrationStore(db),
  };
}

async function profileHarness(
  kind: Kind,
  {
    limiter,
    noProfiles,
    profiles: override,
  }: {
    limiter?: FakeLimiter;
    noProfiles?: boolean;
    profiles?: SellerProfileStore;
  } = {},
) {
  const made = await storesOf(kind);
  if (!made) return null;
  const { db, registrations } = made;
  const profiles = override ?? made.profiles;
  const clock = { now: T0 + 1000 };
  const app = createDiscoveryIndex({
    storage: db ? createD1Storage(db) : createMemoryStorage(),
    limiters: allLimiters(limiter),
    publishers: { mode: PUBLISH_MODES.OPEN },
    registrations,
    ...(noProfiles ? {} : { profiles }),
    now: () => clock.now,
  });
  const call = (path: string, init?: RequestInit) =>
    app.fetch(new Request(INDEX_ORIGIN + path, init));
  async function publish(node: IndexNode) {
    const catalog = node.catalog(1, { issuedAt: clock.now });
    const presence = await node.presence(2, catalog, { issuedAt: clock.now });
    for (const record of [catalog, presence]) {
      const response = await call('/v1/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record }),
      });
      assert.equal(response.status, 201, await response.text());
    }
  }
  const post = (
    body: unknown,
    headers: Record<string, string> = { 'Content-Type': 'application/json' },
  ) =>
    call('/v1/profile', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const signed = (node: IndexNode, patch: Partial<ProfileClaimV1> = {}) =>
    signProfileClaim(
      {
        schemaVersion: PROFILE_CLAIM.schemaVersion,
        nodeId: node.nodeId,
        name: NAME,
        issuedAt: clock.now,
        ...patch,
      },
      node.signer,
    );
  async function name(node: IndexNode, patch: Partial<ProfileClaimV1> = {}) {
    const response = await post(await signed(node, patch));
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const read = (nodeId: string) => call(`/v1/profile/${nodeId}`);
  const network = async () => (await call('/v1/network')).json();
  return {
    db,
    clock,
    profiles,
    registrations,
    publish,
    post,
    signed,
    name,
    read,
    network,
  };
}

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
      named: async () => {
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
    });
    assert.equal(await profiles.put(row(high, 'Zed', 2)), true);
    assert.equal(await profiles.put(row(low, 'Amy', 2)), true);
    assert.equal(await profiles.put(row(low, 'Old', 2)), false);
    assert.equal(await profiles.put(row(low, 'Old', 1)), false);
    assert.deepEqual(await profiles.named(10), [
      { nodeId: low, name: 'Amy' },
      { nodeId: high, name: 'Zed' },
    ]);
    assert.deepEqual(await profiles.named(1), [{ nodeId: low, name: 'Amy' }]);
    assert.equal(await profiles.put(sellerProfileTombstone(high, 3)), true);
    assert.equal(await profiles.put(row(high, 'Zed', 3)), false);
    assert.deepEqual(await profiles.named(10), [{ nodeId: low, name: 'Amy' }]);
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
  await assert.rejects(profiles.named(10), TypeError);
});
