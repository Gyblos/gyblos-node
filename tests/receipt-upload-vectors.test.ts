// Cross-checks receipt upload envelope bytes with an independent Node/OpenSSL oracle.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  RECEIPT_UPLOAD,
  verifyReceiptUpload,
} from '@gyblos/protocol/receipt-upload';
import { signingBytes } from '@gyblos/protocol/signing';

void test('receipt upload vectors match independent canonical bytes and OpenSSL signatures', async () => {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/receipt-upload.json'),
      ),
      'utf8',
    ),
  );
  const data = controlObject(raw, ['description', 'domain', 'cases']);
  assert.equal(data.domain, 'gyblos/receipt-upload/v1\n');
  assert.equal(RECEIPT_UPLOAD.domain, data.domain);
  const names: unknown[] = [];
  for (const item of controlArray(data.cases, 2)) {
    const vector = controlObject(item, ['name', 'signed', 'signingHex']);
    names.push(vector.name);
    const signed = await verifyReceiptUpload(vector.signed);
    assert.deepEqual(signed, vector.signed);
    assert.ok(typeof vector.signingHex === 'string');
    const expected = Buffer.from(vector.signingHex, 'hex');
    assert.deepEqual(
      Buffer.from(signingBytes(RECEIPT_UPLOAD.domain, signed.upload)),
      expected,
    );
    const key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: Buffer.from(signed.upload.uploaderNodeId, 'hex').toString(
          'base64url',
        ),
      },
      format: 'jwk',
    });
    assert.equal(
      verify(null, expected, key, Buffer.from(signed.signature, 'hex')),
      true,
    );
  }
  assert.deepEqual(names, ['seller-free-v1', 'buyer-paid-v2-with-offer']);
});
