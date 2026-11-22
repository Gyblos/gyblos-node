// Overlapping checks of one seller GitHub claim (two scheduled runs, or a run and a POST, reading the same
// snapshot): an inconclusive result moves only checked_at forward (and, on a pending claim, its reason),
// never the state or verifiedAt; a conclusive result computed from an older snapshot never replaces a newer
// conclusive one. Memory and SQLite-backed D1; fake fetcher; offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { GithubClaimRow } from '@gyblos/discovery-index/github-claim-store';
import { recheckGithubClaims } from '@gyblos/discovery-index/github-claims';
import type { GistFetch } from '@gyblos/discovery-index/github-gist';
import { githubProofLine } from '@gyblos/protocol/identity-claim';

import { indexNode, T0 } from './support/discovery-index-fixture';
import {
  ACCOUNT,
  CLAIM_KINDS,
  claimHarness,
  claimStoreOf,
  GIST,
} from './support/github-claim-fixture';

const NODE = '01'.repeat(32);
const row: GithubClaimRow = {
  nodeId: NODE,
  account: ACCOUNT,
  gist: GIST,
  issuedAt: T0,
  state: 'pending',
  reason: null,
  checkedAt: null,
  verdictAt: null,
  verifiedAt: null,
  nextCheckAt: T0,
};

// A fetcher whose answer the test releases later, so two runs overlap.
function held() {
  let release: (answer: Response | Error) => void = () => {};
  const answer = new Promise<Response | Error>((done) => {
    release = done;
  });
  const fetcher: GistFetch = async () => {
    const value = await answer;
    if (value instanceof Error) throw value;
    return value;
  };
  return { fetcher, release };
}
const proof = () => new Response(`${githubProofLine(NODE)}\n`, { status: 200 });

for (const kind of CLAIM_KINDS) {
  void test(`github claim races (${kind}): a late timeout from an older snapshot does not erase a verification`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    await claims.put(row);
    const early = held();
    const late = held();
    // Both runs read the same pending snapshot before either records.
    const first = recheckGithubClaims(claims, early.fetcher, T0 + 10);
    const second = recheckGithubClaims(claims, late.fetcher, T0 + 20);
    await new Promise((done) => setImmediate(done));
    early.release(proof());
    await first;
    late.release(new Error('timeout'));
    await second;
    const stored = await claims.get(NODE);
    assert.equal(stored?.state, 'verified');
    assert.equal(stored?.verifiedAt, T0 + 10);
    assert.equal(stored?.reason, null);
    assert.equal(stored?.checkedAt, T0 + 20);
  });

  void test(`github claim races (${kind}): a conclusive result from an older snapshot does not replace a newer one`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    await claims.put(row);
    const early = held();
    const late = held();
    const first = recheckGithubClaims(claims, early.fetcher, T0 + 10);
    const second = recheckGithubClaims(claims, late.fetcher, T0 + 20);
    await new Promise((done) => setImmediate(done));
    early.release(proof());
    await first;
    // Computed from the pending snapshot, this miss would say pending instead of lost.
    late.release(new Response('no proof\n', { status: 200 }));
    await second;
    const stored = await claims.get(NODE);
    assert.equal(stored?.state, 'verified');
    assert.equal(stored?.verifiedAt, T0 + 10);
  });

  void test(`github claim races (${kind}): a timeout never moves checked_at backwards`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    await claims.put(row);
    const early = held();
    const late = held();
    const first = recheckGithubClaims(claims, early.fetcher, T0 + 10);
    const second = recheckGithubClaims(claims, late.fetcher, T0 + 20);
    await new Promise((done) => setImmediate(done));
    late.release(proof());
    await second;
    early.release(new Error('timeout'));
    await first;
    const stored = await claims.get(NODE);
    assert.equal(stored?.state, 'verified');
    assert.equal(stored?.checkedAt, T0 + 20);
  });

  void test(`github claim races (${kind}): a POST whose check lost the race answers what is stored`, async (context) => {
    let landFirst: () => Promise<unknown> = async () => undefined;
    const index = await claimHarness(kind, {
      // While the POST's own fetch is in flight, a scheduled run verifies the same snapshot first.
      gistFetch: async () => {
        await landFirst();
        return new Response('no proof\n', { status: 200 });
      },
    });
    if (!index) return context.skip('node:sqlite unavailable');
    const node = indexNode();
    await index.publish(node);
    landFirst = async () => {
      landFirst = async () => undefined;
      return recheckGithubClaims(
        index.claims,
        async () =>
          new Response(`${githubProofLine(node.nodeId)}\n`, { status: 200 }),
        index.clock.now,
      );
    };
    const answer = await index.claim(node);
    const stored = await index.claims.get(node.nodeId);
    assert.equal(stored?.state, 'verified');
    assert.deepEqual(answer, { ok: true, state: 'verified', reason: null });
  });

  void test(`github claim races (${kind}): an earlier timeout does not block a later-landing verification`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    await claims.put(row);
    const verifying = held();
    const timingOut = held();
    // Both read the same never-checked snapshot; the timeout lands first and moves checked_at.
    const first = recheckGithubClaims(claims, verifying.fetcher, T0 + 10);
    const second = recheckGithubClaims(claims, timingOut.fetcher, T0 + 20);
    await new Promise((done) => setImmediate(done));
    timingOut.release(new Error('timeout'));
    await second;
    verifying.release(proof());
    await first;
    const stored = await claims.get(NODE);
    assert.equal(stored?.state, 'verified');
    assert.equal(stored?.verifiedAt, T0 + 10);
    assert.equal(stored?.reason, null);
    // checked_at never moves backwards.
    assert.equal(stored?.checkedAt, T0 + 20);
  });
}
