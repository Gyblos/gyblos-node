// Which gists a seller GitHub claim accepts: the proof is read from one named file, so a gist with several
// files works whatever their order; an unlisted (secret) gist is accepted by design, because the index
// publishes the gist id and anyone can then read it, so the proof is public either way. Fake fetcher.
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkGist } from '@gyblos/discovery-index/github-gist';
import { githubProofLine } from '@gyblos/protocol/identity-claim';

import {
  ACCOUNT,
  fakeGists,
  GIST,
  gistUrl,
} from './support/github-claim-fixture';

const NODE = 'ab'.repeat(32);
const claim = { nodeId: NODE, account: ACCOUNT, gist: GIST };

void test('a gist with several files is read through its proof file only', async () => {
  const gists = fakeGists((url) =>
    url === gistUrl(ACCOUNT, GIST)
      ? { status: 200, body: `${githubProofLine(NODE)}\n` }
      : { status: 200, body: 'another file listed first\n' },
  );
  assert.equal(await checkGist(gists.fetcher, claim), null);
  assert.deepEqual(
    gists.requests.map((request) => request.url),
    [gistUrl(ACCOUNT, GIST)],
  );
});

void test('an unlisted (secret) gist is accepted by design: its raw proof file answers like a public one', async () => {
  // GitHub serves a secret gist's raw file to anyone with the id and the owner's name; the index cannot
  // tell it apart and publishes the id, which makes the proof public.
  const gists = fakeGists(() => ({
    status: 200,
    body: `${githubProofLine(NODE)}\n`,
  }));
  assert.equal(await checkGist(gists.fetcher, claim), null);
});
