// New synthetic block vectors are independently checked without changing any existing vectors.
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import type { BatchExecutionRequest } from '@gyblos/protocol/batch-channel';
import {
  decodeSessionBlock,
  encodeSessionBlock,
  SESSION_BLOCKS,
  sessionBlockDigest,
  sessionBlockRequestDigest,
} from '@gyblos/protocol/session-blocks';

void test('session block v5 golden bytes and domains match independent OpenSSL and WebCrypto', async () => {
  const fixture: {
    request: BatchExecutionRequest;
    requestDigest: string;
    blockDigest: string;
    vectors: { value: unknown; canonical: string; frameHex: string }[];
  } = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/session-blocks-v5.json'),
      ),
      'utf8',
    ),
  );
  assert.equal(
    await sessionBlockRequestDigest(fixture.request),
    fixture.requestDigest,
  );
  for (const vector of fixture.vectors) {
    const bytes = Buffer.from(vector.frameHex, 'hex');
    assert.equal(bytes.readUInt32BE(), bytes.length - 4);
    assert.equal(bytes.subarray(4).toString(), vector.canonical);
    assert.deepEqual(Buffer.from(encodeSessionBlock(vector.value)), bytes);
    assert.deepEqual(decodeSessionBlock(bytes), vector.value);
  }
  const first = fixture.vectors[0]!;
  const signing = Buffer.from(SESSION_BLOCKS.digestDomain + first.canonical);
  assert.equal(
    createHash('sha256').update(signing).digest('hex'),
    fixture.blockDigest,
  );
  assert.equal(
    Buffer.from(await webcrypto.subtle.digest('SHA-256', signing)).toString(
      'hex',
    ),
    fixture.blockDigest,
  );
  assert.equal(await sessionBlockDigest(first.value), fixture.blockDigest);
});
