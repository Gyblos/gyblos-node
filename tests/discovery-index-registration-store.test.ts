// Owns the enrollment store's own guarantees (an invite spent once, never after expiry, never on a
// revoked NodeId, even past the route's checks) and the Worker's RPC wiring for registrations (manual
// redirects for Workers, a refused RPC URL leaving the route at 503). Offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { REGISTRATION_STATUS } from '@gyblos/discovery-index/constants';

import {
  expectError,
  INDEX_ORIGIN,
  indexNode,
} from './support/discovery-index-fixture';
import {
  ASSET,
  CHAIN_OWNER,
  enrollmentHarness,
  STORE_KINDS,
} from './support/registration-fixture';

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
    // A revoked NodeId spends no invite and stays revoked.
    harness.setStatus(first, REGISTRATION_STATUS.REVOKED);
    const fresh = await inviteHash(await harness.invite());
    assert.equal(
      await store.redeem({ ...redemption(first), inviteHash: fresh }),
      'revoked',
    );
    assert.equal(await store.active(first), false);
    assert.equal(await store.inviteState(fresh, second, now), 'usable');
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
