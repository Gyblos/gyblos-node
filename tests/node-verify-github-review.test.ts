// Review regressions of `gyblos seller verify github`: Ctrl+C after the gist prompt stops before anything is
// signed or sent; a replacement gist saved for the same account is not discarded because the index still
// shows the old one verified; a failing GitHub CLI ends with a static code and never prints its error
// text or temporary path. Fake index, gist host and GitHub CLI; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyIdentityClaim } from '@gyblos/protocol/identity-claim';

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

void test('verify github: Ctrl+C after the gist prompt submits no claim', () =>
  withKeyedHome(async (home) => {
    const stop = new AbortController();
    const result = await verifyRun(
      home,
      ['github', ACCOUNT],
      world({
        gists: new Map([[rawUrl(), proofBody(home.nodeId)]]),
        posts: [verified()],
      }),
      {
        interrupt: stop.signal,
        prompt: async () => {
          stop.abort();
          return gistUrl();
        },
      },
    );
    assert.equal(result.code, 130);
    assert.equal(result.posted.length, 0);
    assert.match(result.stderr, /^Stopped\./m);
  }));

void test('verify github: a replacement gist saved for the same account is sent, not the old verified one', () =>
  withKeyedHome(async (home) => {
    const state = world({
      claim: view(home.nodeId),
      gists: new Map([
        [rawUrl(), proofBody(home.nodeId)],
        [rawUrl(ACCOUNT, NEW_GIST), proofBody(home.nodeId)],
      ]),
      posts: ['throw'],
    });
    // The seller moved the proof to a new gist and was interrupted before the index heard of it.
    await verifyRun(home, ['github', ACCOUNT, '--gist', NEW_GIST], state);
    state.posts = [verified()];
    const resumed = await verifyRun(home, ['github', ACCOUNT], state);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(resumed.posted.length, 1);
    const signed = await verifyIdentityClaim(resumed.posted[0]);
    assert.equal(signed.claim.gist, NEW_GIST);
    // With nothing new saved, the verified gist still short-circuits.
    const again = await verifyRun(home, ['github', ACCOUNT], {
      ...state,
      claim: view(home.nodeId, { gist: NEW_GIST }),
    });
    assert.match(again.stdout, /^Already verified/m);
    assert.equal(again.posted.length, 0);
  }));

void test('verify github: a failing GitHub CLI ends with a static code and no raw error text', () =>
  withKeyedHome(async (home) => {
    const leak =
      'Command failed: gh gist create /tmp/gyblos-gist-AbC123/gyblos-proof.txt\nHTTP 422: secret detail';
    const result = await verifyRun(
      home,
      ['github', ACCOUNT],
      world({ ghLogin: ACCOUNT, ghCreates: gistUrl() }),
      { ghFails: leak },
    );
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /^The GitHub CLI could not create the gist\..*--gist <gist URL>`\. \[VERIFY_GH_FAILED\]$/m,
    );
    assert.equal(result.stderr.includes('gyblos-gist-'), false);
    assert.equal(result.stderr.includes('secret detail'), false);
    assert.equal(result.posted.length, 0);
  }));
