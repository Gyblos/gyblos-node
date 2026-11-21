// Fix the public release declaration against published bytes produced independently with OpenSSL.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PUBLIC_V2_DOMAINS, SELLER_VERSION } from '@gyblos/protocol/constants';
import { parsePublicV2 } from '@gyblos/protocol/public-v2';
import {
  sellerVersionProof,
  verifiedSellerVersion,
} from '@gyblos/protocol/seller-version';
import { signingBytes } from '@gyblos/protocol/signing';

interface ReleaseVector {
  presence: { record: unknown; signature: string };
  release: string;
  signingBytesHex: string;
  signatureHex: string;
}

void test('the seller release declaration verifies against an independent fixed public vector', async () => {
  const vector: ReleaseVector = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/seller-version-v1.json'),
      ),
      'utf8',
    ),
  );
  const record = parsePublicV2(vector.presence.record);
  const presence = { record, signature: vector.presence.signature };
  const publicKey = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(record.nodeId, 'hex').toString('base64url'),
    },
  });
  assert.ok(
    verify(
      null,
      signingBytes(PUBLIC_V2_DOMAINS[record.kind], record),
      publicKey,
      Buffer.from(presence.signature, 'hex'),
    ),
  );
  const bytes = Buffer.from(vector.signingBytesHex, 'hex');
  assert.ok(
    verify(null, bytes, publicKey, Buffer.from(vector.signatureHex, 'hex')),
  );
  assert.deepEqual(
    bytes,
    Buffer.from(
      signingBytes(SELLER_VERSION.domain, {
        version: vector.release,
        presenceSignature: presence.signature,
      }),
    ),
  );
  const header = vector.release + ':' + vector.signatureHex;
  assert.equal(
    await sellerVersionProof(presence, vector.release, async (signed) => {
      assert.deepEqual(Buffer.from(signed), bytes);
      return Buffer.from(vector.signatureHex, 'hex');
    }),
    header,
  );
  assert.equal(await verifiedSellerVersion(presence, header), vector.release);
});
