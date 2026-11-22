// The seller's local proof pre-check reads a gist exactly as the index does: at most 16 KiB, a line cut at
// that bound never counts, chunk boundaries never matter, and a proof ending the text without a newline
// counts. Streams are built in memory; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  githubProofLine,
  IDENTITY_CLAIM,
} from '@gyblos/protocol/identity-claim';

import { checkGist } from '../apps/node/src/github-verification';

const NODE = 'ab'.repeat(32);
const ACCOUNT = 'octo-cat';
const GIST = '0123456789abcdef0123456789abcdef';
const proof = githubProofLine(NODE);
const max = IDENTITY_CLAIM.maxProofBytes;

function chunked(...parts: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}
const check = (...parts: string[]) =>
  checkGist(
    async () => new Response(chunked(...parts), { status: 200 }),
    ACCOUNT,
    GIST,
    NODE,
  );

void test('a proof early in one chunk far larger than the bound is found', async () => {
  assert.equal(await check(`${proof}\n${'x'.repeat(max * 3)}`), 'found');
});

void test('a proof line split across chunks is found', async () => {
  const half = Math.floor(proof.length / 2);
  assert.equal(
    await check('intro\n', proof.slice(0, half), proof.slice(half), '\nend\n'),
    'found',
  );
});

void test('a proof ending exactly at the bound and at the end of the text is found', async () => {
  const filler = 'x'.repeat(max - proof.length - 1);
  assert.equal(await check(`${filler}\n`, proof), 'found');
});

void test('a proof cut at the bound never counts, whatever the chunks', async () => {
  const filler = 'x'.repeat(max - proof.length - 1);
  assert.equal(await check(`${filler}\n${proof}`, 'tail\n'), 'missing');
  assert.equal(await check(`${filler}\n${proof}tail\n`), 'missing');
});
