// Owns the `gyblos seller verify github` contract: the gist comes from the GitHub CLI, --gist or a pasted
// URL and must belong to the named account; the node key signs the claim the index checks; progress is saved
// privately and every run checks the index and the gist first, so a run stopped at any step resumes; stale
// and deferred answers are retried once; --status and --cancel; plain refusals with static codes. Fake
// index, gist host and GitHub CLI; no network.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  githubProofLine,
  verifyIdentityClaim,
  type SignedIdentityClaim,
} from '@gyblos/protocol/identity-claim';

import {
  ACCOUNT,
  GIST,
  gistUrl,
  json,
  proofBody,
  rawUrl,
  verifyRun,
  view,
  withKeyedHome,
  world,
} from './support/verify-github-fixture';

const OTHER_GIST = 'fedcba9876543210fedc';
const verified = () => json(200, { ok: true, state: 'verified', reason: null });
const progressOf = async (seller: string) =>
  JSON.parse(await readFile(join(seller, 'github-verification.json'), 'utf8'));

async function claims(posted: unknown[]) {
  const out: SignedIdentityClaim[] = [];
  for (const body of posted) out.push(await verifyIdentityClaim(body));
  return out;
}

void test('verify github: with the GitHub CLI signed in as the account it creates the gist, signs and verifies', () =>
  withKeyedHome(async (home) => {
    const state = world({
      ghLogin: ACCOUNT,
      ghCreates: `${gistUrl()}\n`,
      gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
      posts: [verified()],
    });
    const result = await verifyRun(home, ['github', 'Octo-Cat'], state);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.created.length, 1);
    assert.ok(result.created[0]!.includes(githubProofLine(home.nodeId)));
    const [claim] = await claims(result.posted);
    assert.equal(claim!.claim.nodeId, home.nodeId);
    assert.equal(claim!.claim.account, ACCOUNT);
    assert.equal(claim!.claim.gist, GIST);
    assert.match(result.stdout, /Verified: GitHub account octo-cat is linked/);
    assert.ok(result.stdout.includes(gistUrl()));
    const progress = await progressOf(home.seller);
    assert.deepEqual(progress, {
      version: 1,
      nodeId: home.nodeId,
      account: ACCOUNT,
      gist: GIST,
      step: 'verified',
    });
    const mode = (await stat(join(home.seller, 'github-verification.json')))
      .mode;
    if (process.platform !== 'win32') assert.equal(mode & 0o077, 0);
  }));

void test('verify github: without the CLI it prints the text, takes --gist or a pasted URL, and refuses another owner', () =>
  withKeyedHome(async (home) => {
    const gists = new Map([[rawUrl(), proofBody(home.nodeId)]]);
    const stuck = await verifyRun(
      home,
      ['github', ACCOUNT],
      world({ gists, ghLogin: 'someone-else' }),
    );
    assert.equal(stuck.code, 1);
    assert.match(
      stuck.stdout,
      /^The GitHub CLI is signed in as someone-else, not octo-cat, so it is not used\.$/m,
    );
    assert.equal(stuck.created.length, 0);
    assert.ok(stuck.stdout.includes(githubProofLine(home.nodeId)));
    assert.match(stuck.stderr, /^VERIFY_NO_GIST: .*--gist/m);
    assert.equal(stuck.posted.length, 0);
    const other = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', gistUrl('someone')],
      world({ gists }),
    );
    assert.equal(other.code, 1);
    assert.match(
      other.stderr,
      /^VERIFY_GIST_OWNER_MISMATCH: that gist belongs to someone/m,
    );
    assert.equal(other.posted.length, 0);
    const asked: string[] = [];
    const pasted = await verifyRun(
      home,
      ['github', ACCOUNT],
      world({ gists, posts: [verified()] }),
      {
        prompt: async (question) => {
          asked.push(question);
          return ` ${gistUrl('Octo-Cat')}/ `;
        },
      },
    );
    assert.equal(pasted.code, 0, pasted.stderr);
    assert.equal(asked.length, 1);
    const flag = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists, posts: [verified()] }),
    );
    assert.equal(flag.code, 0, flag.stderr);
  }));

void test('verify github: a run stopped after the gist step resumes without a second gist', () =>
  withKeyedHome(async (home) => {
    const state = world({
      ghLogin: ACCOUNT,
      ghCreates: gistUrl(),
      gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
      posts: ['throw'],
    });
    const stopped = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(stopped.code, 1);
    assert.match(stopped.stderr, /^DISCOVERY_NETWORK_FAILED: /m);
    assert.equal((await progressOf(home.seller)).step, 'gist');
    state.posts = [verified()];
    const resumed = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.created.length, 0);
    assert.equal((await progressOf(home.seller)).step, 'verified');
  }));

void test('verify github: a run stopped after posting finds the index verified and posts nothing', () =>
  withKeyedHome(async (home) => {
    const state = world({
      gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
      posts: [
        json(200, { ok: true, state: 'pending', reason: 'GITHUB_UNAVAILABLE' }),
      ],
    });
    const pending = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      state,
    );
    assert.equal(pending.code, 1);
    assert.match(
      pending.stderr,
      /pending: the index could not reach GitHub.*run this again later/,
    );
    assert.equal((await progressOf(home.seller)).step, 'posted');
    state.claim = view(home.nodeId);
    const again = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^Already verified/m);
    assert.equal(again.posted.length, 0);
    assert.equal((await progressOf(home.seller)).step, 'verified');
  }));

void test('verify github: with no local progress the index claim for the account supplies the gist', () =>
  withKeyedHome(async (home) => {
    const state = world({
      claim: view(home.nodeId, {
        state: 'pending',
        reason: 'NODE_ID_MISSING',
        verifiedAt: null,
      }),
      gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
      posts: [verified()],
      ghLogin: ACCOUNT,
    });
    const result = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.created.length, 0);
    assert.equal((await claims(result.posted))[0]!.claim.gist, GIST);
  }));

void test('verify github: a short CHECK_DEFERRED is waited out once; a long one is left for later', () =>
  withKeyedHome(async (home) => {
    const gists = new Map([[rawUrl(), proofBody(home.nodeId)]]);
    const deferred = (retryAfter: number) =>
      json(200, {
        ok: true,
        state: 'pending',
        reason: 'CHECK_DEFERRED',
        retryAfter,
      });
    const short = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists, posts: [deferred(5), verified()] }),
    );
    assert.equal(short.code, 0, short.stderr);
    assert.deepEqual(short.sleeps, [5000]);
    const [first, second] = await claims(short.posted);
    assert.ok(second!.claim.issuedAt > first!.claim.issuedAt);
    const long = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists, posts: [deferred(600)] }),
    );
    assert.equal(long.code, 1);
    assert.deepEqual(long.sleeps, []);
    assert.match(long.stderr, /in about 600 s/);
  }));

void test('verify github: a stale answer is re-signed once with a newer time', () =>
  withKeyedHome(async (home) => {
    const gists = new Map([[rawUrl(), proofBody(home.nodeId)]]);
    const stale = () => json(409, { error: 'STALE_CLAIM' });
    const ok = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists, posts: [stale(), verified()] }),
    );
    assert.equal(ok.code, 0, ok.stderr);
    const [first, second] = await claims(ok.posted);
    assert.ok(second!.claim.issuedAt > first!.claim.issuedAt);
    const twice = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists, posts: [stale(), stale()] }),
    );
    assert.equal(twice.code, 1);
    assert.match(twice.stderr, /^DISCOVERY_STALE_CLAIM: .*clock/m);
    assert.equal(twice.posted.length, 2);
  }));

void test('verify github: unknown sellers, a missing proof line and a missing gist are explained', () =>
  withKeyedHome(async (home) => {
    const unknown = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({
        gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
        posts: [json(403, { error: 'UNKNOWN_NODE' })],
      }),
    );
    assert.equal(unknown.code, 1);
    assert.match(
      unknown.stderr,
      /^DISCOVERY_UNKNOWN_NODE: .*gyblos seller register/m,
    );
    const missing = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', OTHER_GIST],
      world({ gists: new Map([[rawUrl(ACCOUNT, OTHER_GIST), 'hello\n']]) }),
    );
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^VERIFY_PROOF_MISSING: /m);
    assert.ok(missing.stderr.includes(githubProofLine(home.nodeId)));
    assert.equal(missing.posted.length, 0);
    const gone = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world(),
    );
    assert.equal(gone.code, 1);
    assert.match(gone.stderr, /^VERIFY_GIST_NOT_FOUND: /m);
    assert.equal(gone.posted.length, 0);
  }));

void test('verify github: --status shows the index view and --cancel signs a cancel and clears progress', () =>
  withKeyedHome(async (home) => {
    const gists = new Map([[rawUrl(), proofBody(home.nodeId)]]);
    await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists, posts: [verified()] }),
    );
    const status = await verifyRun(
      home,
      ['github', '--status'],
      world({
        claim: view(home.nodeId, { state: 'lost', reason: 'GIST_NOT_FOUND' }),
      }),
    );
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /state {5}lost \(GIST_NOT_FOUND: /);
    assert.ok(status.stdout.includes(gistUrl()));
    const none = await verifyRun(home, ['github', '--status'], world());
    assert.match(none.stdout, /^No GitHub claim/m);
    const cancelled = await verifyRun(
      home,
      ['github', '--cancel'],
      world({ posts: [json(200, { ok: true, state: null, reason: null })] }),
    );
    assert.equal(cancelled.code, 0, cancelled.stderr);
    const [claim] = await claims(cancelled.posted);
    assert.equal(claim!.claim.account, null);
    assert.equal(claim!.claim.gist, null);
    assert.match(cancelled.stdout, /still on GitHub; delete it yourself/);
    assert.ok(cancelled.stdout.includes(gistUrl()));
    await assert.rejects(stat(join(home.seller, 'github-verification.json')));
  }));

void test('verify github: usage and account mistakes are refused before anything is sent', () =>
  withKeyedHome(async (home) => {
    for (const args of [
      ['github'],
      ['gitlab', ACCOUNT],
      ['github', ACCOUNT, '--status'],
      ['github', '--status', '--cancel'],
      ['github', '--gist', GIST],
      ['github', ACCOUNT, 'extra'],
    ]) {
      const result = await verifyRun(home, args, world());
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.stderr, /^Usage: gyblos seller verify github/m);
      assert.equal(result.requests.length, 0);
    }
    for (const account of ['bad-', 'a--b', 'x'.repeat(40), 'a_b']) {
      const result = await verifyRun(home, ['github', account], world());
      assert.match(result.stderr, /^VERIFY_ACCOUNT_INVALID: /m);
      assert.equal(result.requests.length, 0);
    }
  }));
