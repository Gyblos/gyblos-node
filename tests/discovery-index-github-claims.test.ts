// POST /v1/identity/github and its reads: a node-signed claim from a seller the index knows is stored and
// its gist checked at once; states move verified -> lost -> verified on conclusive checks, an outage keeps
// them, a cancel leaves a tombstone (also for a NodeId the index forgot), a NodeId's gist is fetched at
// most once a minute, and replays or unknown NodeIds are refused with static codes. GET returns one claim
// and /v1/network carries only verified accounts and gists. Memory and SQLite-backed D1; fake gist
// fetcher and clock; offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { recheckGithubClaims } from '@gyblos/discovery-index/github-claims';
import { inviteHash } from '@gyblos/discovery-index/registrations';

import {
  deny,
  expectError,
  indexNode,
} from './support/discovery-index-fixture';
import {
  ACCOUNT,
  CLAIM_KINDS,
  claimHarness,
  GIST,
  gistUrl,
  OTHER_GIST,
  proofText,
  signedClaim,
} from './support/github-claim-fixture';

const HOUR = 3_600_000;
// More than the per-NodeId fetch interval, so every POST below fetches.
const MINUTE = 60_001;

for (const kind of CLAIM_KINDS) {
  void test(`github claim (${kind}): a known seller's gist proof verifies and reads back`, async (context) => {
    const index = await claimHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    index.gists.answer(() => ({ status: 200, body: proofText(node.nodeId) }));
    assert.deepEqual(await index.claim(node), {
      ok: true,
      state: 'verified',
      reason: null,
    });
    assert.equal(index.gists.requests.length, 1);
    const [request] = index.gists.requests;
    assert.equal(request?.url, gistUrl(ACCOUNT, GIST));
    assert.equal(request?.init.redirect, 'manual');
    assert.ok(request?.init.signal instanceof AbortSignal);
    const response = await index.read(node.nodeId);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Cache-Control'), 'public, max-age=10');
    const now = index.clock.now;
    assert.deepEqual(await response.json(), {
      nodeId: node.nodeId,
      account: ACCOUNT,
      gist: GIST,
      state: 'verified',
      reason: null,
      checkedAt: now,
      verifiedAt: now,
    });
    const network = await (await index.call('/v1/network')).json();
    assert.deepEqual(network.nodes[0].github, { account: ACCOUNT, gist: GIST });
  });

  void test(`github claim (${kind}): verified becomes lost on a miss, an outage keeps the state, a new binding starts pending`, async (context) => {
    const index = await claimHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    index.gists.answer(() => ({ status: 200, body: proofText(node.nodeId) }));
    await index.claim(node);
    const verifiedAt = index.clock.now;
    // Re-posting the same binding is idempotent: still verified since the first proof.
    index.clock.now += MINUTE;
    assert.equal((await index.claim(node)).state, 'verified');
    assert.equal(
      (await (await index.read(node.nodeId)).json()).verifiedAt,
      verifiedAt,
    );
    index.clock.now += MINUTE;
    index.gists.answer(() => ({ status: 404 }));
    assert.deepEqual(await index.claim(node), {
      ok: true,
      state: 'lost',
      reason: 'GIST_NOT_FOUND',
    });
    // Only verified accounts reach /v1/network; a lost one is read through its own route.
    const listed = await (await index.call('/v1/network')).json();
    assert.equal(listed.nodes[0].github, null);
    for (const outage of [{ status: 503 }, 'throw' as const, { status: 429 }]) {
      index.clock.now += MINUTE;
      index.gists.answer(() => outage);
      // A lost claim keeps its own reason through an outage.
      assert.deepEqual(await index.claim(node), {
        ok: true,
        state: 'lost',
        reason: 'GIST_NOT_FOUND',
      });
      assert.deepEqual(await (await index.read(node.nodeId)).json(), {
        nodeId: node.nodeId,
        account: ACCOUNT,
        gist: GIST,
        state: 'lost',
        reason: 'GIST_NOT_FOUND',
        checkedAt: index.clock.now,
        verifiedAt,
      });
    }
    // Lost becomes verified again with a new streak.
    index.clock.now += MINUTE;
    index.gists.answer(() => ({ status: 200, body: proofText(node.nodeId) }));
    assert.equal((await index.claim(node)).state, 'verified');
    const again = await (await index.read(node.nodeId)).json();
    assert.equal(again.verifiedAt, index.clock.now);
    assert.equal(again.reason, null);
    // A verified claim shows no reason through an outage.
    index.clock.now += MINUTE;
    index.gists.answer(() => ({ status: 503 }));
    assert.deepEqual(await index.claim(node), {
      ok: true,
      state: 'verified',
      reason: null,
    });
    index.clock.now += MINUTE;
    index.gists.answer(() => ({ status: 200, body: 'no proof here\n' }));
    assert.deepEqual(await index.claim(node, { gist: OTHER_GIST }), {
      ok: true,
      state: 'pending',
      reason: 'NODE_ID_MISSING',
    });
    const fresh = await (await index.read(node.nodeId)).json();
    assert.equal(fresh.verifiedAt, null);
    index.clock.now += MINUTE;
    index.gists.answer(() => 'throw');
    assert.deepEqual(await index.claim(node, { gist: OTHER_GIST }), {
      ok: true,
      state: 'pending',
      reason: 'GITHUB_UNAVAILABLE',
    });
    index.clock.now += MINUTE;
    index.gists.answer(() => ({ status: 200, body: proofText(node.nodeId) }));
    assert.equal(
      (await index.claim(node, { gist: OTHER_GIST })).state,
      'verified',
    );
  });

  void test(`github claim (${kind}): a cancel leaves a tombstone that no older claim replaces`, async (context) => {
    const index = await claimHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    index.gists.answer(() => ({ status: 200, body: proofText(node.nodeId) }));
    const first = await signedClaim(node, { issuedAt: index.clock.now });
    assert.equal((await index.post(first)).status, 200);
    await expectError(await index.post(first), 409, 'STALE_CLAIM');
    await expectError(
      await index.post(
        await signedClaim(node, { issuedAt: index.clock.now - 1 }),
      ),
      409,
      'STALE_CLAIM',
    );
    index.clock.now += 1000;
    const fetches = index.gists.requests.length;
    assert.deepEqual(await index.claim(node, { account: null, gist: null }), {
      ok: true,
      state: null,
      reason: null,
    });
    assert.equal(index.gists.requests.length, fetches);
    await expectError(await index.read(node.nodeId), 404, 'NOT_FOUND');
    const network = await (await index.call('/v1/network')).json();
    assert.equal(network.nodes[0].github, null);
    // The captured first claim is still fresh enough, but the tombstone is newer.
    await expectError(await index.post(first), 409, 'STALE_CLAIM');
    // Cancelling again, with nothing stored, still succeeds.
    index.clock.now += 1000;
    assert.equal(
      (await index.claim(node, { account: null, gist: null })).state,
      null,
    );
  });

  void test(`github claim (${kind}): a NodeId's gist is fetched at most once a minute; a deferred claim is due for the next recheck`, async (context) => {
    const index = await claimHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    index.gists.answer(() => ({ status: 200, body: proofText(node.nodeId) }));
    assert.equal((await index.claim(node)).state, 'verified');
    const recheck = () =>
      recheckGithubClaims(index.claims, index.gists.fetcher, index.clock.now);
    // An unchanged binding is deferred too, and still due for the very next scheduled run.
    index.clock.now += 1000;
    assert.deepEqual(await index.claim(node), {
      ok: true,
      state: 'verified',
      reason: 'CHECK_DEFERRED',
      retryAfter: 59,
    });
    assert.equal(index.gists.requests.length, 1);
    assert.equal(await recheck(), 1);
    assert.equal(await recheck(), 0);
    index.clock.now += 1000;
    assert.deepEqual(await index.claim(node, { gist: OTHER_GIST }), {
      ok: true,
      state: 'pending',
      reason: 'CHECK_DEFERRED',
      retryAfter: 58,
    });
    const deferred = await (await index.read(node.nodeId)).json();
    assert.equal(deferred.checkedAt, null);
    assert.equal(await recheck(), 1);
    assert.equal(
      (await (await index.read(node.nodeId)).json()).state,
      'verified',
    );
    index.clock.now += MINUTE;
    assert.deepEqual(await index.claim(node, { gist: OTHER_GIST }), {
      ok: true,
      state: 'verified',
      reason: null,
    });
    assert.equal(index.gists.requests.length, 4);
  });

  void test(`github claim (${kind}): unknown, stale, future, forged and malformed claims are refused`, async (context) => {
    const index = await claimHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const stranger = indexNode();
    const now = index.clock.now;
    await expectError(
      await index.post(await signedClaim(stranger, { issuedAt: now })),
      403,
      'UNKNOWN_NODE',
    );
    const node = indexNode();
    await index.publish(node);
    await expectError(
      await index.post(await signedClaim(node, { issuedAt: now - 60_001 })),
      409,
      'STALE_CLAIM',
    );
    await expectError(
      await index.post(await signedClaim(node, { issuedAt: now + 5001 })),
      400,
      'INVALID_CLAIM',
    );
    const signed = await signedClaim(node, { issuedAt: now });
    await expectError(
      await index.post({
        ...signed,
        claim: { ...signed.claim, account: 'octo-dog' },
      }),
      400,
      'INVALID_SIGNATURE',
    );
    const otherKey = await signedClaim(stranger, { issuedAt: now });
    await expectError(
      await index.post({ claim: signed.claim, signature: otherKey.signature }),
      400,
      'INVALID_SIGNATURE',
    );
    for (const body of [
      '{',
      '[]',
      {
        claim: { ...signed.claim, account: 'Octo' },
        signature: signed.signature,
      },
      { ...signed, extra: 1 },
    ])
      await expectError(await index.post(body), 400, 'INVALID_CLAIM');
    await expectError(
      await index.post(signed, { 'Content-Type': 'text/plain' }),
      400,
      'INVALID_CLAIM',
    );
    await expectError(
      await index.post({ ...signed, pad: 'x'.repeat(1100) }),
      413,
      'PAYLOAD_TOO_LARGE',
    );
    assert.equal(index.gists.requests.length, 0);
    assert.equal(await index.claims.get(node.nodeId), null);
  });

  void test(`github claim (${kind}): a registered seller with no catalog may claim; rate limits apply`, async (context) => {
    const limited = await claimHarness(kind, { limiter: deny });
    if (!limited) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    const response = await limited.post(
      await signedClaim(node, { issuedAt: limited.clock.now }),
    );
    assert.equal(response.status, 429);
    const index = await claimHarness(kind);
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
    index.gists.answer(() => ({ status: 410 }));
    assert.deepEqual(await index.claim(node), {
      ok: true,
      state: 'pending',
      reason: 'GIST_NOT_FOUND',
    });
  });

  void test(`github claim (${kind}): reads refuse malformed NodeIds and query strings`, async (context) => {
    const index = await claimHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const nodeId = 'ab'.repeat(32);
    await expectError(await index.read(nodeId), 404, 'NOT_FOUND');
    for (const path of ['AB'.repeat(32), 'ab'.repeat(31), `${nodeId}?x=1`]) {
      const response = await index.read(path);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
      await expectError(response, 400, 'INVALID_QUERY');
    }
  });

  void test(`github claim (${kind}): without a claim store both routes fail closed`, async (context) => {
    const index = await claimHarness(kind, { noClaims: true });
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    await expectError(
      await index.post(await signedClaim(node, { issuedAt: index.clock.now })),
      503,
      'DISCOVERY_UNAVAILABLE',
    );
    await expectError(
      await index.read(node.nodeId),
      503,
      'DISCOVERY_UNAVAILABLE',
    );
    const network = await (await index.call('/v1/network')).json();
    assert.equal(network.nodes[0].github, null);
  });
}
