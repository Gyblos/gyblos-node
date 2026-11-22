import assert from 'node:assert/strict';
import test from 'node:test';

import { expectError, indexNode } from './support/discovery-index-fixture';
import {
  claimHarness,
  OTHER_GIST,
  proofText,
} from './support/github-claim-fixture';

async function seeded() {
  const index = await claimHarness('sqlite-d1');
  if (!index?.db) return null;
  const node = indexNode();
  await index.publish(node);
  index.gists.answer(() => ({ status: 200, body: proofText(node.nodeId) }));
  await index.claim(node);
  const stored = await (await index.read(node.nodeId)).json();
  assert.match(stored.signature, /^[0-9a-f]{128}$/);
  return { index, node, db: index.db };
}

void test('a cancel written by a pre-signature Worker reads as cancelled and a new claim replaces it', async (context) => {
  const made = await seeded();
  if (!made) return context.skip('node:sqlite unavailable');
  const { index, node, db } = made;
  db.raw
    .prepare(
      `UPDATE discovery_github_claims SET issued_at = issued_at + 1, account = NULL, gist = NULL,
       state = NULL, reason = NULL, checked_at = NULL, verdict_at = NULL, verified_at = NULL,
       next_check_at = NULL WHERE node_id = ?`,
    )
    .run(node.nodeId);
  await expectError(await index.read(node.nodeId), 404, 'NOT_FOUND');
  index.clock.now += 60_001;
  assert.equal((await index.claim(node)).state, 'verified');
  const page = await (await index.read(node.nodeId)).json();
  assert.equal(page.issuedAt, index.clock.now);
  assert.match(page.signature, /^[0-9a-f]{128}$/);
});

void test('a replacement written by a pre-signature Worker never serves the old signature', async (context) => {
  const made = await seeded();
  if (!made) return context.skip('node:sqlite unavailable');
  const { index, node, db } = made;
  db.raw
    .prepare(
      'UPDATE discovery_github_claims SET issued_at = issued_at + 1, gist = ? WHERE node_id = ?',
    )
    .run(OTHER_GIST, node.nodeId);
  const page = await (await index.read(node.nodeId)).json();
  assert.equal(page.gist, OTHER_GIST);
  assert.equal(page.signature, null);
});
