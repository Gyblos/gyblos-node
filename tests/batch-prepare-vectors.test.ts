// Independent native-crypto golden protects additive PREPARE bytes without mutating older vectors.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_CHANNEL,
  batchChannelDigest,
  matchBatchChannelResponse,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import {
  ControlFrameReader,
  encodeControlFrame,
} from '@gyblos/protocol/control-framing';
import { signingBytes } from '@gyblos/protocol/signing';

interface Vector {
  request: unknown;
  response: unknown;
  canonicalRequest: string;
  requestSigningHex: string;
  requestDigest: string;
  requestFrameHex: string;
  responseFrameHex: string;
}
void test('PREPARE canonical frames and SHA-256 match independent Node crypto vector', async () => {
  const fixture: Vector = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/batch-prepare-v3.json'),
      ),
      'utf8',
    ),
  );
  const request = parseBatchChannelRequest(fixture.request);
  assert.equal(canonicalJson(request), fixture.canonicalRequest);
  const bytes = signingBytes(BATCH_CHANNEL.replyDomain, request);
  assert.equal(Buffer.from(bytes).toString('hex'), fixture.requestSigningHex);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    fixture.requestDigest,
  );
  assert.equal(await batchChannelDigest(request), fixture.requestDigest);
  assert.equal(
    Buffer.from(
      encodeControlFrame(request, BATCH_CHANNEL.requestBytes),
    ).toString('hex'),
    fixture.requestFrameHex,
  );
  const reader = new ControlFrameReader(BATCH_CHANNEL.responseBytes);
  reader.push(Buffer.from(fixture.responseFrameHex, 'hex'));
  assert.deepEqual(
    await matchBatchChannelResponse(reader.finish(), request),
    fixture.response,
  );
});
