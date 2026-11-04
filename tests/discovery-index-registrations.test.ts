// Owns POST /v1/registrations and registered publishing: a one-use invite plus a NodeId the 8004
// registry binds on chain admits that NodeId to publish; bad, used or expired invites, unregistered
// NodeIds and chain outages refuse without spending the invite; only the invite's hash, the chain's
// owner and asset and a country code are stored. Memory and SQLite-backed D1 adapters; offline.
import assert from 'node:assert/strict';
import test from 'node:test';

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
    // Again: already active, answered without the chain and without spending another invite.
    const spare = await harness.invite();
    const again = await harness.register({
      invite: spare,
      nodeId: seller.nodeId,
    });
    assert.equal(again.status, 200);
    assert.equal(harness.registry.lookups.length, 1);
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

  void test(`registrations (${kind}): a revoked NodeId stops publishing until a new invite`, async (context) => {
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
    await harness.revoke(seller.nodeId);
    await expectError(
      await harness.app.fetch(publish(await seller.catalog(2))),
      403,
      'PUBLISH_NOT_ALLOWED',
    );
    assert.equal(
      (
        await harness.register({
          invite: await harness.invite(),
          nodeId: seller.nodeId,
        })
      ).status,
      201,
    );
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
  assert.equal(
    (
      await harness.register({ invite, nodeId }, undefined, {
        country: 'Chile',
      })
    ).status,
    201,
  );
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
  // An allowlisted NodeId publishes even when the registration tables cannot be read.
  const listed = indexNode();
  const broken = {
    createInvite: async () => {},
    inviteUsable: async () => false,
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

void test('the Worker maps the RPC secret and asks for manual redirects, which Workers supports', async () => {
  const { edgeFetch, createWorker } =
    await import('@gyblos/discovery-index/worker');
  const seen: RequestInit[] = [];
  const recorder = (async (_url: string, init: RequestInit) => {
    seen.push(init);
    return new Response('{}');
  }) as typeof fetch;
  await edgeFetch(recorder)('https://rpc.example.com/v2/key', {
    redirect: 'error',
    method: 'POST',
  });
  await edgeFetch(recorder)('https://rpc.example.com/v2/key', {
    method: 'POST',
  });
  assert.deepEqual(
    seen.map((init) => [init.redirect, init.method]),
    [
      ['manual', 'POST'],
      [undefined, 'POST'],
    ],
  );
  // A URL the reader refuses (a query string may carry a key) leaves the route at 503.
  const { allLimiters } = await import('./support/discovery-index-fixture');
  const { createSqliteD1 } = await import('./support/d1-sqlite');
  const db = await createSqliteD1();
  if (!db) return;
  const response = await createWorker().fetch(
    new Request(`${INDEX_ORIGIN}/v1/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invite: `gyb_${'a'.repeat(26)}`,
        nodeId: 'ab'.repeat(32),
      }),
    }),
    {
      DISCOVERY_DB: db,
      ...allLimiters(),
      DISCOVERY_SOLANA_RPC_URL: 'https://rpc.example.com/?api-key=secret',
    },
  );
  await expectError(response, 503, 'DISCOVERY_UNAVAILABLE');
});

for (const kind of STORE_KINDS)
  void test(`registration store (${kind}): redeem itself spends an invite once and never after expiry`, async (context) => {
    // Called directly, as a request racing past the route's inviteUsable check would.
    const harness = await enrollmentHarness(kind);
    if (!harness) return context.skip('node:sqlite unavailable');
    const { inviteHash } =
      await import('@gyblos/discovery-index/registrations');
    const store = harness.registrations;
    const now = harness.clock.now;
    const hash = await inviteHash(
      await harness.invite('seller@example.com', 1000),
    );
    const redemption = (nodeId: string, at = now) => ({
      inviteHash: hash,
      nodeId,
      owner: CHAIN_OWNER,
      asset: ASSET,
      country: null,
      now: at,
    });
    const late = indexNode().nodeId;
    assert.equal(
      await store.redeem(redemption(late, now + 1000)),
      'invite-invalid',
    );
    assert.equal(await store.active(late), false);
    const first = indexNode().nodeId;
    assert.equal(await store.redeem(redemption(first)), 'registered');
    const second = indexNode().nodeId;
    assert.equal(await store.redeem(redemption(second)), 'invite-invalid');
    assert.equal(await store.active(second), false);
    assert.equal(await store.active(first), true);
  });
