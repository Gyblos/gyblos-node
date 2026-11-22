// The gist check and the scheduled recheck of seller GitHub claims: which statuses and texts conclude a
// check, the 16 KiB read bound (a cut never makes a proof line), one bounded batch of the least recently
// checked claims per run, a newer claim never overwritten by a check of an older one, and the Worker's
// scheduled entry over D1. Fake fetcher and clock; offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { GITHUB_CLAIM } from '@gyblos/discovery-index/constants';
import {
  githubClaimTombstone,
  type GithubClaimRow,
} from '@gyblos/discovery-index/github-claim-store';
import { recheckGithubClaims } from '@gyblos/discovery-index/github-claims';
import { checkGist } from '@gyblos/discovery-index/github-gist';
import { scheduledRecheck } from '@gyblos/discovery-index/worker';
import { githubProofLine } from '@gyblos/protocol/identity-claim';

import { T0 } from './support/discovery-index-fixture';
import {
  ACCOUNT,
  CLAIM_KINDS,
  claimStoreOf,
  fakeGists,
  GIST,
  gistUrl,
  type GistAnswer,
} from './support/github-claim-fixture';

const NODE = 'ab'.repeat(32);
const claim = { nodeId: NODE, account: ACCOUNT, gist: GIST };

async function outcome(answer: GistAnswer) {
  return checkGist(fakeGists(() => answer).fetcher, claim);
}

function row(index: number, patch: Partial<GithubClaimRow> = {}) {
  return {
    nodeId: index.toString(16).padStart(64, '0'),
    account: ACCOUNT,
    gist: GIST,
    issuedAt: T0,
    state: 'pending',
    reason: null,
    checkedAt: null,
    verifiedAt: null,
    ...patch,
  } satisfies GithubClaimRow;
}

void test('only 429, 5xx and network errors are inconclusive; any other status, redirects included, is not found', async () => {
  for (const status of [301, 302, 307, 400, 403, 404, 410])
    assert.equal(await outcome({ status }), 'GIST_NOT_FOUND', `${status}`);
  for (const status of [429, 500, 502, 503])
    assert.equal(await outcome({ status }), 'GITHUB_UNAVAILABLE', `${status}`);
  assert.equal(await outcome('throw'), 'GITHUB_UNAVAILABLE');
});

void test('the proof line must stand on its own line with the exact lowercase NodeId', async () => {
  const proof = githubProofLine(NODE);
  assert.equal(await outcome({ status: 200, body: proof }), null);
  assert.equal(await outcome({ status: 200, body: `﻿${proof}\n` }), null);
  for (const body of [
    '',
    `${proof}x`,
    `x${proof}`,
    proof.toUpperCase(),
    `gyblos-node=${'cd'.repeat(32)}`,
    `gyblos-node = ${NODE}`,
  ])
    assert.equal(await outcome({ status: 200, body }), 'NODE_ID_MISSING', body);
});

void test('only the first 16 KiB are read, and a line cut at the bound never counts', async () => {
  const proof = githubProofLine(NODE);
  const max = GITHUB_CLAIM.maxGistBytes;
  const early = `${proof}\n${'x'.repeat(max * 4)}`;
  assert.equal(await outcome({ status: 200, body: early }), null);
  const late = `${'x'.repeat(max)}\n${proof}\n`;
  assert.equal(await outcome({ status: 200, body: late }), 'NODE_ID_MISSING');
  const filler = 'x'.repeat(max - proof.length - 1);
  const cut = `${filler}\n${proof}tail\n`;
  assert.equal(await outcome({ status: 200, body: cut }), 'NODE_ID_MISSING');
  assert.equal(
    await outcome({ status: 200, body: `${filler}\n${proof}` }),
    null,
  );
});

for (const kind of CLAIM_KINDS) {
  void test(`recheck (${kind}): one bounded batch of the least recently checked claims per run`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    const now = T0 + GITHUB_CLAIM.recheckAfterMs * 2;
    const total = GITHUB_CLAIM.recheckBatch + 3;
    for (let index = 1; index <= total; index++)
      await claims.put(
        row(index, {
          state: 'verified',
          verifiedAt: T0,
          checkedAt: index === 1 ? null : T0 + index,
        }),
      );
    // Checked recently: not due.
    await claims.put(
      row(total + 1, { checkedAt: now - GITHUB_CLAIM.recheckAfterMs + 1 }),
    );
    const gists = fakeGists(() => ({ status: 404 }));
    assert.equal(
      await recheckGithubClaims(claims, gists.fetcher, now),
      GITHUB_CLAIM.recheckBatch,
    );
    assert.equal(gists.requests.length, GITHUB_CLAIM.recheckBatch);
    const first = await claims.get(row(1).nodeId);
    assert.deepEqual(
      { ...first },
      {
        ...row(1),
        state: 'lost',
        reason: 'GIST_NOT_FOUND',
        checkedAt: now,
        verifiedAt: T0,
      },
    );
    const untouched = await claims.get(row(total).nodeId);
    assert.equal(untouched?.state, 'verified');
    assert.equal(untouched?.checkedAt, T0 + total);
    // The next run takes the rest; the recently checked claim waits.
    assert.equal(await recheckGithubClaims(claims, gists.fetcher, now), 3);
    assert.equal(await recheckGithubClaims(claims, gists.fetcher, now), 0);
  });

  void test(`recheck (${kind}): an outage moves checked_at only and a newer claim is never overwritten`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    const stored = row(1, {
      state: 'verified',
      checkedAt: T0,
      verifiedAt: T0,
    });
    await claims.put(stored);
    const now = T0 + GITHUB_CLAIM.recheckAfterMs + 1;
    await recheckGithubClaims(claims, fakeGists(() => 'throw').fetcher, now);
    assert.deepEqual(
      { ...(await claims.get(stored.nodeId)) },
      {
        ...stored,
        checkedAt: now,
      },
    );
    // A check of the claim issued at T0 lands after a newer claim replaced it: it changes nothing.
    const newer = row(1, { issuedAt: T0 + 1, gist: 'ab'.repeat(10) });
    assert.equal(await claims.put(newer), true);
    assert.equal(await claims.put(stored), false);
    await claims.record(stored.nodeId, stored.issuedAt, {
      state: 'lost',
      reason: 'GIST_NOT_FOUND',
      checkedAt: now,
      verifiedAt: T0,
    });
    assert.deepEqual({ ...(await claims.get(stored.nodeId)) }, newer);
    // A cancel keeps a tombstone: no older claim replaces it, it is never due and never recorded.
    const tombstone = githubClaimTombstone(stored.nodeId, newer.issuedAt + 1);
    assert.equal(
      await claims.put(githubClaimTombstone(stored.nodeId, newer.issuedAt)),
      false,
    );
    assert.equal(await claims.put(tombstone), true);
    assert.equal(await claims.put(newer), false);
    await claims.record(stored.nodeId, tombstone.issuedAt, {
      state: 'verified',
      reason: null,
      checkedAt: now,
      verifiedAt: now,
    });
    assert.deepEqual({ ...(await claims.get(stored.nodeId)) }, tombstone);
    assert.deepEqual(await claims.due(now * 2, 10), []);
    assert.deepEqual(await claims.verified(10), []);
  });

  void test(`recheck (${kind}): a fetch is reserved at most once per NodeId per interval, across claims`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    const interval = GITHUB_CLAIM.minFetchIntervalMs;
    const first = row(1);
    await claims.put(first);
    assert.equal(
      await claims.reserveFetch(first.nodeId, T0 + 1, T0, interval),
      false,
    );
    assert.equal(
      await claims.reserveFetch(first.nodeId, T0, T0, interval),
      true,
    );
    const next = row(1, { issuedAt: T0 + 1, gist: 'ab'.repeat(10) });
    await claims.put(next);
    assert.equal(
      await claims.reserveFetch(
        next.nodeId,
        next.issuedAt,
        T0 + interval - 1,
        interval,
      ),
      false,
    );
    assert.equal(
      await claims.reserveFetch(
        next.nodeId,
        next.issuedAt,
        T0 + interval,
        interval,
      ),
      true,
    );
    assert.equal(
      await claims.reserveFetch(row(2).nodeId, T0, T0, interval),
      false,
    );
  });
}

void test('the scheduled entry rechecks due claims in D1 and does nothing without a database', async (context) => {
  const made = await claimStoreOf('sqlite-d1');
  if (!made?.db) return context.skip('node:sqlite unavailable');
  await made.claims.put(row(1));
  const gists = fakeGists(() => ({
    status: 200,
    body: githubProofLine(row(1).nodeId),
  }));
  const fetcher: typeof fetch = (input, init) =>
    gists.fetcher(String(input), init ?? {});
  const now = T0 + 1000;
  assert.equal(
    await scheduledRecheck({ DISCOVERY_DB: made.db }, now, fetcher),
    1,
  );
  assert.equal(gists.requests[0]?.url, gistUrl(ACCOUNT, GIST));
  assert.equal(gists.requests[0]?.init.redirect, 'manual');
  const checked = await made.claims.get(row(1).nodeId);
  assert.equal(checked?.state, 'verified');
  assert.equal(checked?.verifiedAt, now);
  assert.equal(await scheduledRecheck({}, now, fetcher), 0);
});
