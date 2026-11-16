// Verifies independent OpenSSL reference bytes; only synthetic quote inputs include dummy endpoints.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CONTROL_DOMAINS } from '@gyblos/protocol/constants';
import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  offerDigestV2,
  parseOfferV2,
  verifyOfferV2,
} from '@gyblos/protocol/offer-v2';
import {
  buildReceiptUploadOfferV2,
  RECEIPT_UPLOAD_V2,
  verifyReceiptUploadV2,
} from '@gyblos/protocol/receipt-upload-v2';
import { signingBytes } from '@gyblos/protocol/signing';

void test('upload v2 vectors independently bind complete quotes and envelope signatures', async () => {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL(
        import.meta.resolve('@gyblos/protocol/vectors/receipt-upload-v2.json'),
      ),
      'utf8',
    ),
  );
  const data = controlObject(raw, [
    'description',
    'domain',
    'offerDomain',
    'offer',
    'offerSignature',
    'offerSigningHex',
    'offerDigest',
    'cases',
  ]);
  assert.equal(data.domain, 'gyblos/receipt-upload/v2\n');
  assert.equal(RECEIPT_UPLOAD_V2.domain, data.domain);
  assert.equal(data.offerDomain, CONTROL_DOMAINS.OFFER);
  const offer = parseOfferV2(data.offer);
  assert.deepEqual(
    await verifyOfferV2(
      { offer, signature: data.offerSignature },
      { owner: offer.owner, nodeId: offer.nodeId, now: offer.issuedAt },
    ),
    offer,
  );
  assert.ok(typeof data.offerSigningHex === 'string');
  const offerBytes = Buffer.from(data.offerSigningHex, 'hex');
  assert.deepEqual(
    Buffer.from(signingBytes(CONTROL_DOMAINS.OFFER, offer)),
    offerBytes,
  );
  assert.equal(
    createHash('sha256').update(offerBytes).digest('hex'),
    data.offerDigest,
  );
  assert.equal(await offerDigestV2(offer), data.offerDigest);
  const facts = await buildReceiptUploadOfferV2(offer);
  const names: unknown[] = [];
  for (const item of controlArray(data.cases, 2)) {
    const vector = controlObject(item, ['name', 'signed', 'signingHex']);
    names.push(vector.name);
    const signed = await verifyReceiptUploadV2(vector.signed);
    assert.deepEqual(signed, vector.signed);
    assert.ok(typeof vector.signingHex === 'string');
    const expected = Buffer.from(vector.signingHex, 'hex');
    assert.deepEqual(
      Buffer.from(signingBytes(RECEIPT_UPLOAD_V2.domain, signed.upload)),
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
    assert.equal(
      JSON.stringify(signed.upload).includes(offer.endpoint.relayUrl!),
      false,
    );
    const reference = signed.upload.items[0]!.offer;
    if (reference !== null) {
      assert.deepEqual(reference, facts);
      const record = signed.upload.items[0]!.receipt.seller.record;
      assert.equal(record.requestId, offer.requestId);
      assert.notEqual(record.requestDigest, offer.requestDigest);
    }
  }
  assert.deepEqual(names, [
    'seller-free-v1',
    'buyer-paid-v2-with-quote-reference',
  ]);
});
