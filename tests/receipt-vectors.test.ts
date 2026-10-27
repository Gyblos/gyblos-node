// Cross-checks receipt canonical bytes and signatures with WebCrypto and independent OpenSSL vectors.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { RECEIPT } from '@gyblos/protocol/constants';
import {
  sellerReceiptDigest,
  verifyReceipt,
  type ReceiptV1,
} from '@gyblos/protocol/receipt';
import { signingBytes } from '@gyblos/protocol/signing';

interface Vector {
  name: string;
  receipt: ReceiptV1;
  sellerSigningHex: string;
  buyerSigningHex?: string;
  sellerDigest: string;
}
void test('receipt golden vectors match independent canonical bytes, digest and both signature implementations', async () => {
  const vectors: { cases: Vector[] } = JSON.parse(
    await readFile(
      new URL(import.meta.resolve('@gyblos/protocol/vectors/receipt-v1.json')),
      'utf8',
    ),
  );
  assert.ok(vectors.cases.length >= 3);
  for (const vector of vectors.cases) {
    assert.deepEqual(await verifyReceipt(vector.receipt), vector.receipt);
    assert.equal(
      await sellerReceiptDigest(vector.receipt.seller.record),
      vector.sellerDigest,
    );
    for (const [signed, domain, expected, nodeId] of [
      [
        vector.receipt.seller,
        RECEIPT.sellerDomain,
        vector.sellerSigningHex,
        vector.receipt.seller.record.sellerNodeId,
      ],
      ...(vector.receipt.buyer
        ? [
            [
              vector.receipt.buyer,
              RECEIPT.buyerDomain,
              vector.buyerSigningHex!,
              vector.receipt.buyer.record.buyerNodeId,
            ] as const,
          ]
        : []),
    ] as const) {
      const bytes = signingBytes(domain, signed.record);
      assert.equal(Buffer.from(bytes).toString('hex'), expected);
      const key = createPublicKey({
        key: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: Buffer.from(nodeId, 'hex').toString('base64url'),
        },
        format: 'jwk',
      });
      assert.equal(
        verify(null, bytes, key, Buffer.from(signed.signature, 'hex')),
        true,
      );
    }
  }
});
