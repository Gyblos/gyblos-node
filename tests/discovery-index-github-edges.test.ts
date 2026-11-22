// Seller GitHub claim edges at the discovery index: a NodeId the index no longer knows can still cancel
// (signed, replay-protected) but not claim, and /v1/network keeps answering, without GitHub data, when
// the claims table is missing. Memory and SQLite-backed D1; fake gist fetcher and clock; offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { expectError, indexNode } from './support/discovery-index-fixture';
import {
  ACCOUNT,
  CLAIM_KINDS,
  claimHarness,
  GIST,
  signedClaim,
} from './support/github-claim-fixture';

for (const kind of CLAIM_KINDS) {
  void test(`github claim (${kind}): a NodeId the index forgot can still cancel, but not claim`, async (context) => {
    const index = await claimHarness(kind);
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    const now = index.clock.now;
    // Never known, nothing stored: the cancel succeeds and writes nothing.
    assert.deepEqual(await index.claim(node, { account: null, gist: null }), {
      ok: true,
      state: null,
      reason: null,
    });
    assert.equal(await index.claims.get(node.nodeId), null);
    // Known once: its claim is stored; then the index forgets it (a fresh app over the same claims).
    await index.claims.put({
      nodeId: node.nodeId,
      account: ACCOUNT,
      gist: GIST,
      issuedAt: now,
      state: 'verified',
      reason: null,
      checkedAt: now,
      verifiedAt: now,
      nextCheckAt: now,
    });
    await expectError(
      await index.post(await signedClaim(node, { issuedAt: now + 1 })),
      403,
      'UNKNOWN_NODE',
    );
    await expectError(
      await index.post(
        await signedClaim(node, { issuedAt: now, account: null, gist: null }),
      ),
      409,
      'STALE_CLAIM',
    );
    const cancel = await signedClaim(node, {
      issuedAt: now + 2,
      account: null,
      gist: null,
    });
    const forged = { ...cancel, signature: '00'.repeat(64) };
    await expectError(await index.post(forged), 400, 'INVALID_SIGNATURE');
    assert.equal((await index.post(cancel)).status, 200);
    await expectError(await index.read(node.nodeId), 404, 'NOT_FOUND');
    await expectError(await index.post(cancel), 409, 'STALE_CLAIM');
  });
}

void test('github claim: /v1/network still answers, with no GitHub data, marked incomplete, when the claims table is missing', async (context) => {
  const index = await claimHarness('sqlite-d1');
  if (!index?.db) return context.skip('node:sqlite unavailable');
  const node = indexNode();
  await index.publish(node);
  index.db.raw.exec('DROP TABLE discovery_github_claims');
  const response = await index.call('/v1/network');
  assert.equal(response.status, 200);
  const network = await response.json();
  assert.equal(network.nodes[0].nodeId, node.nodeId);
  assert.equal(network.nodes[0].github, null);
  // Not complete: a cache keeps this page only as an incomplete one.
  assert.equal(network.truncated, true);
  await expectError(
    await index.read(node.nodeId),
    503,
    'DISCOVERY_UNAVAILABLE',
  );
});
