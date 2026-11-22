// The read-only operator listing of seller GitHub claims (`pnpm index:github-claims`): rows by state,
// tombstones left out, local or remote target, bad options refused, nothing written. SQLite-backed D1
// stands in for Wrangler; offline.
import assert from 'node:assert/strict';
import test from 'node:test';

import { githubClaimTombstone } from '@gyblos/discovery-index/github-claim-store';
import { runGithubClaims } from '@gyblos/discovery-index/github-claims-admin';

import { T0 } from './support/discovery-index-fixture';
import { ACCOUNT, claimStoreOf, GIST } from './support/github-claim-fixture';

const row = (index: number) => ({
  nodeId: index.toString(16).padStart(64, '0'),
  account: ACCOUNT,
  gist: GIST,
  issuedAt: T0,
  state: 'pending' as const,
  reason: null,
  checkedAt: null,
  verifiedAt: null,
  nextCheckAt: T0,
});

void test('the operator listing reads claims without writing, filtered by state, and refuses bad options', async (context) => {
  const made = await claimStoreOf('sqlite-d1');
  if (!made?.db) return context.skip('node:sqlite unavailable');
  const db = made.db;
  await made.claims.put({
    ...row(1),
    state: 'verified',
    verifiedAt: T0,
    checkedAt: T0,
  });
  await made.claims.put({
    ...row(2),
    reason: 'NODE_ID_MISSING',
    checkedAt: T0,
  });
  await made.claims.put(githubClaimTombstone(row(3).nodeId, T0));
  const before = JSON.stringify(
    db.raw.prepare('SELECT * FROM discovery_github_claims').all(),
  );
  const run = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const remotes: boolean[] = [];
    const code = runGithubClaims(argv, {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      query: (sql, remote) => {
        remotes.push(remote);
        return db.raw.prepare(sql).all();
      },
    });
    return { code, out: out.join(''), err: err.join(''), remotes };
  };
  const all = run([]);
  assert.equal(all.code, 0);
  assert.deepEqual(all.remotes, [false]);
  assert.match(all.out, /2 claim\(s\)\n$/);
  assert.ok(
    all.out.includes(
      `${row(2).nodeId}\t${ACCOUNT}\t${GIST}\tpending\tNODE_ID_MISSING\t`,
    ),
  );
  const pending = run(['--state', 'pending', '--remote']);
  assert.deepEqual(pending.remotes, [true]);
  assert.match(pending.out, /1 claim\(s\)\n$/);
  assert.ok(!pending.out.includes(row(1).nodeId));
  for (const argv of [['--state', 'gone'], ['--nope']]) {
    const bad = run(argv);
    assert.equal(bad.code, 1);
    assert.deepEqual(bad.remotes, []);
    assert.match(bad.err, /usage/);
  }
  assert.equal(
    JSON.stringify(
      db.raw.prepare('SELECT * FROM discovery_github_claims').all(),
    ),
    before,
  );
});
