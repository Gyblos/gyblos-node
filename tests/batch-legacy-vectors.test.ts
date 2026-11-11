// Retired session v1 bytes remain immutable and independently verifiable; no v1 runtime stack is kept.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { parseBatchChannelRequest } from '@gyblos/protocol/batch-channel';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';

interface LegacyVector {
  request: unknown;
  canonicalRequest: string;
  requestSigningHex: string;
  requestDigest: string;
  requestFrameHex: string;
}
const LEGACY_VECTORS = [
  [
    'batch-channel-v1.json',
    'af54cab7c1e7313d0b26292c2a3e36db7dc0987f0b5c7fca95777b0e0c87e952',
  ],
  [
    'batch-prepare-v1.json',
    'a510884f5eb25f049c3d045c3c3b5ceda3e7ee562b00b0db0a79e31fb71e9930',
  ],
  [
    'batch-startup-v1.json',
    '7b72e839a2758a0039976002dc3dc828a781a3732df4944de48e1edaebb2b64f',
  ],
] as const;
for (const [name, expected] of LEGACY_VECTORS) {
  void test(`retired ${name} keeps its bytes and is refused by session v2`, async () => {
    const body = await readFile(
      new URL(import.meta.resolve(`@gyblos/protocol/vectors/${name}`)),
    );
    assert.equal(createHash('sha256').update(body).digest('hex'), expected);
    const value: LegacyVector | LegacyVector[] = JSON.parse(body.toString());
    for (const vector of Array.isArray(value) ? value : [value]) {
      const bytes = Buffer.from(
        'gyblos/session-rpc/v1\n' + vector.canonicalRequest,
      );
      assert.equal(bytes.toString('hex'), vector.requestSigningHex);
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        vector.requestDigest,
      );
      const frame = Buffer.from(vector.requestFrameHex, 'hex');
      assert.equal(frame.readUInt32BE(), frame.length - 4);
      assert.equal(frame.subarray(4).toString(), vector.canonicalRequest);
      assert.throws(() => parseBatchChannelRequest(vector.request), {
        code: SESSION_CODES.INVALID,
      });
    }
  });
}
