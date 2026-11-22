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

import { T0 } from './support/discovery-index-fixture';
import {
  ACCOUNT,
  CLAIM_KINDS,
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
}
