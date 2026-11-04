// Owns POST /v1/registrations and registered publishing: a one-use invite plus a NodeId the 8004
// registry binds on chain admits that NodeId to publish; bad, used or expired invites, unregistered
// NodeIds and chain outages refuse without spending the invite; only the invite's hash, the chain's
// owner and asset and a country code are stored. Memory and SQLite-backed D1 adapters; offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { REGISTRATION_STATUS } from '@gyblos/discovery-index/constants';

import {
  CLIENT_IP,
  deny,
  expectError,
  INDEX_ORIGIN,
  indexNode,
} from './support/discovery-index-fixture';
import {
  ASSET,
  CHAIN_OWNER,
  enrollmentHarness,
  STORE_KINDS,
  type ChainAnswer,
} from './support/registration-fixture';

const publish = (signed: unknown) =>
  new Request(`${INDEX_ORIGIN}/v1/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': CLIENT_IP,
    },
    body: JSON.stringify({ record: signed }),
  });

const health = async (app: {
  fetch(request: Request): Promise<Response> | Response;
}) => (await app.fetch(new Request(`${INDEX_ORIGIN}/v1/health`))).json();

for (const kind of STORE_KINDS) {
  void test(`registrations (${kind}): an invite and a bound NodeId admit the seller to publish`, async (context) => {
    const harness = await enrollmentHarness(kind);
    if (!harness) return context.skip('node:sqlite unavailable');
    const seller = indexNode();
    await expectError(
      await harness.app.fetch(publish(await seller.catalog(1))),
      403,
      'PUBLISH_NOT_ALLOWED',
    );
    assert.deepEqual(await health(harness.app), {
      ok: true,
      records: 0,
      publish: 'registered',
    });
    const code = await harness.invite();
    const created = await harness.register(
      { invite: code, nodeId: seller.nodeId },
      { 'Content-Type': 'application/json' },
      { country: 'CL' },
    );
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { ok: true, status: 'active' });
    assert.deepEqual(harness.registry.lookups, [seller.nodeId]);
    assert.equal(
      (await harness.app.fetch(publish(await seller.catalog(2)))).status,
      201,
    );
    // A retry with the same invite answers 200 without the chain.
    const retry = await harness.register({
      invite: code,
      nodeId: seller.nodeId,
    });
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), { ok: true, status: 'active' });
    assert.equal(harness.registry.lookups.length, 1);
    // Without a valid invite nothing says whether a NodeId is registered.
    await expectError(
      await harness.register({
        invite: `gyb_${'z'.repeat(26)}`,
        nodeId: seller.nodeId,
      }),
      403,
      'INVITE_INVALID',
    );
    // Another invite for an active NodeId answers 200 and is not spent.
    const spare = await harness.invite();
    const again = await harness.register({
      invite: spare,
      nodeId: seller.nodeId,
    });
    assert.equal(again.status, 200);
    assert.equal(
      (await harness.register({ invite: spare, nodeId: indexNode().nodeId }))
        .status,
      201,
    );
    if (harness.db) {
      // Only the hash and the chain's owner and asset are stored, never the code.
      const dump = harness.db.dump();
      assert.equal(dump.includes(code), false);
      const row = harness.db.raw
        .prepare(
          'SELECT owner, asset, country, status FROM discovery_registrations WHERE node_id = ?',
        )
        .get(seller.nodeId);
      assert.deepEqual(
        { ...row },
        {
          owner: CHAIN_OWNER,
          asset: ASSET,
          country: 'CL',
          status: 'active',
        },
      );
    }
  });

  void test(`registrations (${kind}): unknown, used and expired invites refuse before the chain is read`, async (context) => {
    const harness = await enrollmentHarness(kind);
    if (!harness) return context.skip('node:sqlite unavailable');
    const first = indexNode();
    const code = await harness.invite();
    assert.equal(
      (await harness.register({ invite: code, nodeId: first.nodeId })).status,
      201,
    );
    const lookups = harness.registry.lookups.length;
    const other = indexNode().nodeId;
    await expectError(
      await harness.register({ invite: code, nodeId: other }),
      403,
      'INVITE_INVALID',
    );
    await expectError(
      await harness.register({
        invite: `gyb_${'z'.repeat(26)}`,
        nodeId: other,
      }),
      403,
      'INVITE_INVALID',
    );
    const expiring = await harness.invite('seller@example.com', 1000);
    harness.clock.now += 1000;
    await expectError(
      await harness.register({ invite: expiring, nodeId: other }),
      403,
      'INVITE_INVALID',
    );
    assert.equal(harness.registry.lookups.length, lookups);
  });

  void test(`registrations (${kind}): an unregistered NodeId or a chain outage keeps the invite unspent`, async (context) => {
    let answer: ChainAnswer = 'missing';
    const harness = await enrollmentHarness(kind, { chain: () => answer });
    if (!harness) return context.skip('node:sqlite unavailable');
    const nodeId = indexNode().nodeId;
    const invite = await harness.invite();
    await expectError(
      await harness.register({ invite, nodeId }),
      403,
      'IDENTITY_NOT_REGISTERED',
    );
    answer = 'unavailable';
    await expectError(
      await harness.register({ invite, nodeId }),
      503,
      'DISCOVERY_UNAVAILABLE',
    );
    // A binding for another NodeId is not this seller's registration.
    answer = 'other-node';
    await expectError(
      await harness.register({ invite, nodeId }),
      503,
      'DISCOVERY_UNAVAILABLE',
    );
    answer = 'bound';
    assert.equal((await harness.register({ invite, nodeId })).status, 201);
    assert.equal(harness.registry.lookups.length, 4);
  });

  void test(`registrations (${kind}): a revoked NodeId stops publishing, no invite readmits it, restore does`, async (context) => {
    const harness = await enrollmentHarness(kind);
    if (!harness) return context.skip('node:sqlite unavailable');
    const seller = indexNode();
    await harness.register({
      invite: await harness.invite(),
      nodeId: seller.nodeId,
    });
    assert.equal(
      (await harness.app.fetch(publish(await seller.catalog(1)))).status,
      201,
    );
    harness.setStatus(seller.nodeId, REGISTRATION_STATUS.REVOKED);
    await expectError(
      await harness.app.fetch(publish(await seller.catalog(2))),
      403,
      'PUBLISH_NOT_ALLOWED',
    );
    const spare = await harness.invite();
    await expectError(
      await harness.register({ invite: spare, nodeId: seller.nodeId }),
      403,
      'NODE_REVOKED',
    );
    // The refused invite is not spent.
    assert.equal(
      (await harness.register({ invite: spare, nodeId: indexNode().nodeId }))
        .status,
      201,
    );
    harness.setStatus(seller.nodeId, REGISTRATION_STATUS.ACTIVE);
    assert.equal(
      (await harness.app.fetch(publish(await seller.catalog(3)))).status,
      201,
    );
  });
}

void test('registrations: malformed bodies, oversized bodies and the publish limit refuse', async () => {
  const harness = (await enrollmentHarness('memory'))!;
  const nodeId = indexNode().nodeId;
  const invite = await harness.invite();
  for (const body of [
    'not json',
    [],
    { invite },
    { invite, nodeId, extra: 1 },
    { invite: 'gyb_short', nodeId },
    { invite: invite.toUpperCase(), nodeId },
    { invite, nodeId: nodeId.toUpperCase() },
    { invite, nodeId: 7 },
  ])
    await expectError(
      await harness.register(body),
      400,
      'INVALID_REGISTRATION',
    );
  await expectError(
    await harness.register(
      { invite, nodeId },
      { 'Content-Type': 'text/plain' },
    ),
    400,
    'INVALID_REGISTRATION',
  );
  await expectError(
    await harness.register(
      JSON.stringify({ invite, nodeId, pad: 'x'.repeat(600) }),
    ),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  assert.equal(harness.registry.lookups.length, 0);
  // A country that is not a two-letter code is not stored; the registration still succeeds.
  const stored = (await enrollmentHarness('sqlite-d1'))!;
  if (stored) {
    assert.equal(
      (
        await stored.register(
          { invite: await stored.invite(), nodeId },
          undefined,
          { country: 'Chile' },
        )
      ).status,
      201,
    );
    const row = stored
      .db!.raw.prepare(
        'SELECT country FROM discovery_registrations WHERE node_id = ?',
      )
      .get(nodeId);
    assert.deepEqual({ ...row }, { country: null });
  }
  const limited = (await enrollmentHarness('memory', { limiter: deny }))!;
  await expectError(
    await limited.register({ invite: await limited.invite(), nodeId }),
    429,
    'RATE_LIMITED',
  );
});

void test('registrations: no registry or no store answers 503, and the allowlist still publishes', async () => {
  const withoutRegistry = (await enrollmentHarness('memory', {
    registry: undefined,
  }))!;
  await expectError(
    await withoutRegistry.register({
      invite: await withoutRegistry.invite(),
      nodeId: indexNode().nodeId,
    }),
    503,
    'DISCOVERY_UNAVAILABLE',
  );
  // No store and no allowlist: registration and publishing are both closed.
  const closed = (await enrollmentHarness('memory', {
    registrations: undefined,
  }))!;
  await expectError(
    await closed.register({
      invite: `gyb_${'a'.repeat(26)}`,
      nodeId: indexNode().nodeId,
    }),
    503,
    'DISCOVERY_UNAVAILABLE',
  );
  await expectError(
    await closed.app.fetch(publish(await indexNode().catalog(1))),
    503,
    'DISCOVERY_UNAVAILABLE',
  );
  assert.deepEqual(await health(closed.app), {
    ok: true,
    records: 0,
    publish: 'closed',
  });
  // An allowlisted NodeId publishes even when the registration tables cannot be read.
  const listed = indexNode();
  const broken = {
    createInvite: async () => {},
    inviteState: async () => 'invalid' as const,
    redeem: async () => {
      throw new Error('no table');
    },
    active: async (): Promise<boolean> => {
      throw new Error('no table');
    },
  };
  const harness = (await enrollmentHarness('memory', {
    registrations: broken,
    publishers: { mode: 'allowlist', nodeIds: new Set([listed.nodeId]) },
  }))!;
  assert.equal(
    (await harness.app.fetch(publish(await listed.catalog(1)))).status,
    201,
  );
  await expectError(
    await harness.app.fetch(publish(await indexNode().catalog(1))),
    503,
    'DISCOVERY_UNAVAILABLE',
  );
  assert.deepEqual(await health(harness.app), {
    ok: true,
    records: 1,
    publish: 'allowlist',
  });
});
