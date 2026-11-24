// Recovery paths of `gyblos seller verify github`: a saved gist that disappeared is dropped so a plain rerun
// makes a new one; a gist made before an interruption is found again instead of duplicated; a refused cancel
// keeps local progress; a node key that cannot sign, an unwritable seller directory and a GitHub answer that
// is neither yes nor no each end with a plain sentence and a static code. Fake index, gist host and gh.
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

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

const NEW_GIST = 'fedcba9876543210fedc';
const verified = () => json(200, { ok: true, state: 'verified', reason: null });
const progressOf = async (seller: string) =>
  JSON.parse(await readFile(join(seller, 'github-verification.json'), 'utf8'));

void test('verify github: a saved gist that is gone is dropped, and a plain rerun makes a new one', () =>
  withKeyedHome(async (home) => {
    const state = world({
      gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
      posts: ['throw'],
    });
    await verifyRun(home, ['github', ACCOUNT, '--gist', GIST], state);
    assert.equal((await progressOf(home.seller)).gist, GIST);
    state.gists = new Map();
    state.claim = view(home.nodeId, { state: 'pending', verifiedAt: null });
    const gone = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(gone.code, 1);
    assert.match(
      gone.stderr,
      /^The gist .* is no longer on GitHub\. Run the same command again to make a new one, or run again with --gist <new gist URL>\. \[VERIFY_GIST_NOT_FOUND\]$/m,
    );
    assert.equal((await progressOf(home.seller)).step, 'gist-missing');
    // Neither the saved gist nor the index's copy of it is used again.
    state.ghLogin = ACCOUNT;
    state.ghCreates = gistUrl(ACCOUNT, NEW_GIST);
    state.gists = new Map([
      [rawUrl(ACCOUNT, NEW_GIST), proofBody(home.nodeId)],
    ]);
    state.posts = [verified()];
    const fresh = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.equal(fresh.created.length, 1);
    assert.equal((await progressOf(home.seller)).gist, NEW_GIST);
  }));

void test('verify github: a gist made before an interruption is found by its description, not made again', () =>
  withKeyedHome(async (home) => {
    const state = world({
      ghLogin: ACCOUNT,
      ghCreates: gistUrl(),
      gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
    });
    // Stopped right after gh made the gist, before anything was saved.
    await writeFile(join(home.seller, 'github-verification.json'), '{', {
      mode: 0o600,
    });
    state.posts = ['throw'];
    const first = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(first.created.length, 1);
    assert.deepEqual(first.descriptions, [
      `Gyblos node verification ${home.nodeId}`,
    ]);
    await writeFile(join(home.seller, 'github-verification.json'), '{', {
      mode: 0o600,
    });
    state.posts = [verified()];
    const again = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.created.length, 0);
    assert.match(again.stdout, /^Using your existing proof gist /m);
  }));

void test('verify github: a refused cancel keeps local progress', () =>
  withKeyedHome(async (home) => {
    const gists = new Map([[rawUrl(), proofBody(home.nodeId)]]);
    await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists, posts: [verified()] }),
    );
    for (const refusal of [
      json(503, { error: 'DISCOVERY_UNAVAILABLE' }),
      json(200, { ok: true, state: 'verified', reason: null }),
    ]) {
      const result = await verifyRun(
        home,
        ['github', '--cancel'],
        world({ posts: [refusal] }),
      );
      assert.equal(result.code, 1);
      assert.equal((await progressOf(home.seller)).gist, GIST);
    }
  }));

void test('verify github: a key that cannot sign and an unwritable home end with a sentence and a code', () =>
  withKeyedHome(async (home) => {
    const gists = new Map([[rawUrl(), proofBody(home.nodeId)]]);
    const key = join(home.seller, 'node.key');
    const original = await readFile(key, 'utf8');
    await writeFile(key, JSON.stringify(Array(32).fill(7)), { mode: 0o600 });
    const mismatched = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists, posts: [verified()] }),
    );
    assert.equal(mismatched.code, 1);
    assert.match(
      mismatched.stderr,
      /^This seller's node key could not sign the claim\. Run `gyblos doctor`\. \[VERIFY_SIGNING_FAILED\]$/m,
    );
    assert.equal(mismatched.posted.length, 0);
    await writeFile(key, original, { mode: 0o600 });
    if (process.platform === 'win32') return;
    await chmod(home.seller, 0o500);
    try {
      const locked = await verifyRun(
        home,
        ['github', ACCOUNT, '--gist', GIST],
        world({ gists, posts: [verified()] }),
      );
      assert.equal(locked.code, 1);
      assert.match(locked.stderr, /\[VERIFY_STATE_FAILED\]$/m);
      assert.equal(locked.posted.length, 0);
    } finally {
      await chmod(home.seller, 0o700);
    }
  }));

void test('verify github: a 403 or 5xx from GitHub does not stop the run; the index decides', () =>
  withKeyedHome(async (home) => {
    for (const status of [403, 503]) {
      const result = await verifyRun(
        home,
        ['github', ACCOUNT, '--gist', GIST],
        world({
          gists: new Map([[rawUrl(), { status }]]),
          posts: [verified()],
        }),
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.posted.length, 1);
    }
  }));

void test('verify github: --status names the verification in progress here', () =>
  withKeyedHome(async (home) => {
    await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({
        gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
        posts: ['throw'],
      }),
    );
    const status = await verifyRun(home, ['github', '--status'], world());
    assert.match(
      status.stdout,
      /^ {2}In progress here: octo-cat\. Run `gyblos seller verify github octo-cat` to continue\.$/m,
    );
  }));
