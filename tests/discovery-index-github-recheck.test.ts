// The gist check and the scheduled recheck of seller GitHub claims: which statuses and texts conclude a
// check, the 16 KiB read bound (a cut never makes a proof line), one bounded batch of due claims per
// run, abandoned pending claims left alone, a newer claim or later check never overwritten, tombstones,
// the per-NodeId fetch slot, malformed rows skipped and the Worker's scheduled entry over D1 (one static
// log line without the table). Fake fetcher and clock; offline.
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
import {
  githubProofLine,
  IDENTITY_CLAIM,
} from '@gyblos/protocol/identity-claim';

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
    nextCheckAt: T0,
    ...patch,
  } satisfies GithubClaimRow;
}

void test('403, 429, 451, 5xx and network errors are inconclusive; any other status, redirects included, is not found', async () => {
  for (const status of [301, 302, 307, 400, 401, 404, 410])
    assert.equal(await outcome({ status }), 'GIST_NOT_FOUND', `${status}`);
  for (const status of [403, 429, 451, 500, 502, 503])
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
  const max = IDENTITY_CLAIM.maxProofBytes;
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

const DAY = 86_400_000;

for (const kind of CLAIM_KINDS) {
  void test(`recheck (${kind}): one bounded batch of due claims per run, earliest first`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    const now = T0 + GITHUB_CLAIM.recheckAfterMs;
    const total = GITHUB_CLAIM.recheckBatch + 3;
    for (let index = 1; index <= total; index++)
      await claims.put(
        row(index, {
          state: 'verified',
          verifiedAt: T0,
          checkedAt: T0,
          nextCheckAt: T0 + index,
        }),
      );
    // Not due yet, and a tombstone: never checked.
    await claims.put(row(total + 1, { nextCheckAt: now + 1 }));
    await claims.put(githubClaimTombstone(row(total + 2).nodeId, T0));
    const gists = fakeGists(() => ({ status: 404 }));
    assert.equal(
      await recheckGithubClaims(claims, gists.fetcher, now),
      GITHUB_CLAIM.recheckBatch,
    );
    assert.equal(gists.requests.length, GITHUB_CLAIM.recheckBatch);
    assert.deepEqual(
      { ...(await claims.get(row(1).nodeId)) },
      {
        ...row(1),
        state: 'lost',
        reason: 'GIST_NOT_FOUND',
        checkedAt: now,
        verifiedAt: T0,
        nextCheckAt: now + GITHUB_CLAIM.recheckAfterMs,
      },
    );
    const untouched = await claims.get(row(total).nodeId);
    assert.equal(untouched?.state, 'verified');
    assert.equal(await recheckGithubClaims(claims, gists.fetcher, now), 3);
    assert.equal(await recheckGithubClaims(claims, gists.fetcher, now), 0);
  });

  void test(`recheck (${kind}): an outage keeps the state; only a pending claim stores GITHUB_UNAVAILABLE`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    const verified = row(1, {
      state: 'verified',
      checkedAt: T0,
      verifiedAt: T0,
    });
    const lost = row(2, {
      state: 'lost',
      reason: 'NODE_ID_MISSING',
      checkedAt: T0,
      verifiedAt: T0,
    });
    const pending = row(3);
    for (const entry of [verified, lost, pending]) await claims.put(entry);
    const now = T0 + 1;
    await recheckGithubClaims(claims, fakeGists(() => 'throw').fetcher, now);
    const after = {
      checkedAt: now,
      nextCheckAt: now + GITHUB_CLAIM.recheckAfterMs,
    };
    assert.deepEqual(
      { ...(await claims.get(verified.nodeId)) },
      { ...verified, ...after },
    );
    assert.deepEqual(
      { ...(await claims.get(lost.nodeId)) },
      { ...lost, ...after },
    );
    assert.deepEqual(
      { ...(await claims.get(pending.nodeId)) },
      { ...pending, ...after, reason: 'GITHUB_UNAVAILABLE' },
    );
  });

  void test(`recheck (${kind}): a pending claim never verified stops being rechecked after 7 days`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    const fresh = row(1);
    const old = row(2);
    const lostOld = row(3, { state: 'lost', verifiedAt: T0, checkedAt: T0 });
    for (const entry of [fresh, old, lostOld]) await claims.put(entry);
    const gists = fakeGists(() => ({ status: 404 }));
    const now = T0 + GITHUB_CLAIM.abandonPendingAfterMs;
    assert.equal(
      await recheckGithubClaims(claims, gists.fetcher, now - DAY),
      3,
    );
    assert.equal(
      (await claims.get(fresh.nodeId))?.nextCheckAt,
      now - DAY + GITHUB_CLAIM.recheckAfterMs,
    );
    const later = now + GITHUB_CLAIM.recheckAfterMs;
    assert.equal(await recheckGithubClaims(claims, gists.fetcher, later), 3);
    for (const entry of [fresh, old]) {
      const stored = await claims.get(entry.nodeId);
      assert.equal(stored?.state, 'pending');
      assert.equal(stored?.nextCheckAt, null);
    }
    assert.equal((await claims.get(lostOld.nodeId))?.state, 'lost');
    assert.equal(
      await recheckGithubClaims(claims, gists.fetcher, later * 2),
      1,
    );
  });

  void test(`recheck (${kind}): a newer claim, a later check or a tombstone is never overwritten`, async (context) => {
    const made = await claimStoreOf(kind);
    if (!made) return context.skip('node:sqlite unavailable');
    const { claims } = made;
    const stored = row(1);
    await claims.put(stored);
    const late = {
      state: 'verified',
      reason: null,
      checkedAt: T0 + 20,
      verifiedAt: T0 + 20,
      nextCheckAt: T0 + 20 + GITHUB_CLAIM.recheckAfterMs,
    } as const;
    await claims.record(stored.nodeId, stored.issuedAt, null, late);
    // A check computed from the same, now outdated, snapshot lands later: it changes nothing.
    await claims.record(stored.nodeId, stored.issuedAt, null, {
      state: 'pending',
      reason: 'GIST_NOT_FOUND',
      checkedAt: T0 + 10,
      verifiedAt: null,
      nextCheckAt: T0 + 10,
    });
    assert.deepEqual(
      { ...(await claims.get(stored.nodeId)) },
      { ...stored, ...late },
    );
    const newer = row(1, { issuedAt: T0 + 1, gist: 'ab'.repeat(10) });
    assert.equal(await claims.put(newer), true);
    assert.equal(await claims.put(stored), false);
    await claims.record(stored.nodeId, stored.issuedAt, null, {
      ...late,
      checkedAt: T0 + 30,
    });
    assert.deepEqual({ ...(await claims.get(stored.nodeId)) }, newer);
    const tombstone = githubClaimTombstone(stored.nodeId, newer.issuedAt + 1);
    assert.equal(
      await claims.put(githubClaimTombstone(stored.nodeId, newer.issuedAt)),
      false,
    );
    assert.equal(await claims.put(tombstone), true);
    assert.equal(await claims.put(newer), false);
    await claims.record(stored.nodeId, tombstone.issuedAt, null, {
      ...late,
      checkedAt: T0 + 40,
    });
    assert.deepEqual({ ...(await claims.get(stored.nodeId)) }, tombstone);
    assert.deepEqual(await claims.due(T0 * 2, 10), []);
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
      interval,
    );
    assert.equal(await claims.reserveFetch(first.nodeId, T0, T0, interval), 0);
    const next = row(1, { issuedAt: T0 + 1, gist: 'ab'.repeat(10) });
    await claims.put(next);
    assert.equal(
      await claims.reserveFetch(
        next.nodeId,
        next.issuedAt,
        T0 + interval - 1000,
        interval,
      ),
      1000,
    );
    assert.equal(
      await claims.reserveFetch(
        next.nodeId,
        next.issuedAt,
        T0 + interval,
        interval,
      ),
      0,
    );
    assert.equal(
      await claims.reserveFetch(row(2).nodeId, T0, T0, interval),
      interval,
    );
  });
}

void test('the scheduled entry rechecks due claims in D1, does nothing without a database and stays quiet without the table', async (context) => {
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
  const warn = context.mock.method(console, 'warn', () => undefined);
  made.db.raw.exec('DROP TABLE discovery_github_claims');
  assert.equal(
    await scheduledRecheck({ DISCOVERY_DB: made.db }, now, fetcher),
    0,
  );
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [['DISCOVERY_GITHUB_RECHECK_FAILED']],
  );
});

void test('a malformed row is unscheduled and skipped, so the batch keeps moving', async (context) => {
  const made = await claimStoreOf('sqlite-d1');
  if (!made?.db) return context.skip('node:sqlite unavailable');
  await made.claims.put(row(2, { nextCheckAt: T0 + 1 }));
  made.db.raw.exec(
    `INSERT INTO discovery_github_claims (node_id, account, gist, issued_at, state, reason, next_check_at) VALUES ('${row(1).nodeId}', 'octo-cat', '${GIST}', ${T0}, 'pending', 'BOGUS', ${T0})`,
  );
  const gists = fakeGists(() => ({ status: 404 }));
  assert.equal(
    await recheckGithubClaims(made.claims, gists.fetcher, T0 + 1),
    1,
  );
  assert.equal(gists.requests.length, 1);
  const bad = made.db.raw
    .prepare(
      'SELECT next_check_at FROM discovery_github_claims WHERE node_id = ?',
    )
    .get(row(1).nodeId);
  assert.equal(bad?.next_check_at, null);
  assert.equal(
    await recheckGithubClaims(made.claims, gists.fetcher, T0 + 1),
    0,
  );
});
