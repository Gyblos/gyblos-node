// Edge cases of the gist step of `gyblos seller verify github`: a gist whose file is not named
// gyblos-proof.txt is told apart from a missing gist (and is not dropped), every not-found message names the
// file, and whatever the GitHub CLI prints (login, gist ids) is validated before use or display. Fakes only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  ACCOUNT,
  GIST,
  proofBody,
  verifyRun,
  withKeyedHome,
  world,
} from './support/verify-github-fixture';

const bareRaw = (account = ACCOUNT, gist = GIST) =>
  `https://gist.githubusercontent.com/${account}/${gist}/raw`;
const progressOf = async (seller: string) =>
  JSON.parse(await readFile(join(seller, 'github-verification.json'), 'utf8'));

void test('verify github: a gist without a file named gyblos-proof.txt is told to rename it, not dropped', () =>
  withKeyedHome(async (home) => {
    const result = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world({ gists: new Map([[bareRaw(), proofBody(home.nodeId)]]) }),
    );
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /^The gist .* exists but has no file named gyblos-proof\.txt\. Rename its file to gyblos-proof\.txt, then run the same command again\. \[VERIFY_PROOF_FILE_MISSING\]$/m,
    );
    assert.equal((await progressOf(home.seller)).step, 'gist');
    assert.equal(result.posted.length, 0);
  }));

void test('verify github: a missing gist names the proof file', () =>
  withKeyedHome(async (home) => {
    const result = await verifyRun(
      home,
      ['github', ACCOUNT, '--gist', GIST],
      world(),
    );
    assert.match(
      result.stderr,
      /gyblos-proof\.txt.*\[VERIFY_GIST_NOT_FOUND\]$/m,
    );
  }));

void test('verify github: an odd GitHub CLI login or gist id is refused without printing it', () =>
  withKeyedHome(async (home) => {
    const odd = await verifyRun(
      home,
      ['github', ACCOUNT],
      world({ ghLogin: 'octo\u001b[31mcat' }),
    );
    assert.equal(odd.code, 1);
    assert.match(
      odd.stderr,
      /^The GitHub CLI could not create the gist\..*\[VERIFY_GH_FAILED\]$/m,
    );
    assert.equal((odd.stdout + odd.stderr).includes('\u001b'), false);
    const listed = await verifyRun(
      home,
      ['github', ACCOUNT],
      world({
        ghLogin: ACCOUNT,
        ghGists: new Map([
          [`Gyblos node verification ${home.nodeId}`, 'ZZ\nnot-an-id'],
        ]),
      }),
    );
    assert.equal(listed.code, 1);
    assert.match(listed.stderr, /\[VERIFY_GH_FAILED\]$/m);
    assert.equal(listed.stdout.includes('not-an-id'), false);
    const created = await verifyRun(
      home,
      ['github', ACCOUNT],
      world({
        ghLogin: ACCOUNT,
        ghCreates: 'https://gist.github.com/octo-cat/\u001b[2J',
      }),
    );
    assert.equal(created.code, 1);
    assert.match(created.stderr, /\[VERIFY_GH_FAILED\]$/m);
  }));
