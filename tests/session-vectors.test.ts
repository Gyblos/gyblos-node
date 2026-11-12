// New optional startup terms have independent plain-Node canonical/digest/frame vectors; old fixtures stay intact.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { canonicalJson } from '@gyblos/protocol';
import {
  BATCH_CHANNEL,
  batchChannelDigest,
  parseBatchChannelRequest,
} from '@gyblos/protocol/batch-channel';
import { encodeControlFrame } from '@gyblos/protocol/control-framing';
import { signingBytes } from '@gyblos/protocol/signing';

interface Vector {
  request: unknown;
  canonicalRequest: string;
  requestSigningHex: string;
  requestDigest: string;
  requestFrameHex: string;
}
for (const index of [0, 1]) {
  void test(`startup terms vector ${index + 1} matches independent bytes, digest and frame`, async () => {
    const vectors: Vector[] = JSON.parse(
      await readFile(
        new URL(
          import.meta.resolve('@gyblos/protocol/vectors/batch-startup-v4.json'),
        ),
        'utf8',
      ),
    );
    const vector = vectors[index]!;
    const request = parseBatchChannelRequest(vector.request);
    assert.equal(canonicalJson(request), vector.canonicalRequest);
    const bytes = signingBytes(BATCH_CHANNEL.replyDomain, request);
    assert.equal(Buffer.from(bytes).toString('hex'), vector.requestSigningHex);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      vector.requestDigest,
    );
    assert.equal(await batchChannelDigest(request), vector.requestDigest);
    assert.equal(
      Buffer.from(
        encodeControlFrame(request, BATCH_CHANNEL.requestBytes),
      ).toString('hex'),
      vector.requestFrameHex,
    );
  });
}
