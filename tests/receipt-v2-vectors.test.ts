// Cross-checks the new wire bytes with an independent Node/OpenSSL oracle and freezes old vectors.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  controlArray,
  controlObject,
} from '@gyblos/protocol/control-validation';
import {
  RECEIPT_V2,
  sellerReceiptDigestV2,
  verifyReceiptV2,
} from '@gyblos/protocol/receipt-v2';
import { signingBytes } from '@gyblos/protocol/signing';

void test('paid receipt/v2 vectors match independent canonical bytes, SHA-256 and OpenSSL signatures', async () => {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL(import.meta.resolve('@gyblos/protocol/vectors/receipt-v2.json')),
      'utf8',
    ),
  );
  const data = controlObject(raw, [
    'description',
    'sellerDomain',
    'buyerDomain',
    'cases',
  ]);
  assert.equal(data.sellerDomain, 'gyblos/receipt-seller/v2\n');
  assert.equal(data.buyerDomain, 'gyblos/receipt-buyer/v2\n');
  assert.equal(RECEIPT_V2.sellerDomain, data.sellerDomain);
  assert.equal(RECEIPT_V2.buyerDomain, data.buyerDomain);
  const cases = controlArray(data.cases, 5);
  const names: unknown[] = [];
  const fees: string[] = [];
  for (const item of cases) {
    assert.ok(item && typeof item === 'object');
    const hasBuyer = Object.hasOwn(item, 'buyerSigningHex');
    const vector = controlObject(item, [
      'name',
      'receipt',
      'sellerSigningHex',
      'sellerDigest',
      ...(hasBuyer ? ['buyerSigningHex'] : []),
    ]);
    names.push(vector.name);
    const receipt = await verifyReceiptV2(vector.receipt);
    assert.deepEqual(receipt, vector.receipt);
    assert.equal(
      await sellerReceiptDigestV2(receipt.seller.record),
      vector.sellerDigest,
    );
    fees.push(receipt.seller.record.feeAtomic);
    const halves = [
      {
        signed: receipt.seller,
        domain: RECEIPT_V2.sellerDomain,
        expected: vector.sellerSigningHex,
        nodeId: receipt.seller.record.sellerNodeId,
      },
      ...(receipt.buyer
        ? [
            {
              signed: receipt.buyer,
              domain: RECEIPT_V2.buyerDomain,
              expected: vector.buyerSigningHex,
              nodeId: receipt.buyer.record.buyerNodeId,
            },
          ]
        : []),
    ];
    for (const half of halves) {
      assert.ok(typeof half.expected === 'string');
      const expected = Buffer.from(half.expected, 'hex');
      assert.deepEqual(
        Buffer.from(signingBytes(half.domain, half.signed.record)),
        expected,
      );
      const key = createPublicKey({
        key: {
          kty: 'OKP',
          crv: 'Ed25519',
          x: Buffer.from(half.nodeId, 'hex').toString('base64url'),
        },
        format: 'jwk',
      });
      assert.equal(
        verify(null, expected, key, Buffer.from(half.signed.signature, 'hex')),
        true,
      );
      if (half.signed === receipt.seller)
        assert.equal(
          createHash('sha256').update(expected).digest('hex'),
          vector.sellerDigest,
        );
    }
  }
  assert.deepEqual(names, [
    'paid-first-interval',
    'paid-next-interval',
    'paid-zero-authorization-seller-only',
    'paid-maximum-cumulative',
    'paid-disputed-usage',
  ]);
  assert.deepEqual(fees, ['2', '3', '0', '3', '3']);
});
void test('existing receipt/v1 and receipt-channel/v1 vectors remain byte-identical', async () => {
  for (const [entry, expected] of [
    [
      '@gyblos/protocol/vectors/receipt-v1.json',
      '957c526593adbb3128153e5ca5642d98975786011550cdca9937498ec3e49d85',
    ],
    [
      '@gyblos/protocol/vectors/receipt-channel-v1.json',
      '5cb8dd977345597778fc0eb108b8758d231d154d4cb771eea0e39a805fb49a5a',
    ],
  ]) {
    const bytes = await readFile(new URL(import.meta.resolve(entry!)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  }
});
