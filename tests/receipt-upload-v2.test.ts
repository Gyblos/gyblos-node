// Checks versioned exact-quote claims without changing v1 receipt or upload contracts.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import {
  parseReceiptUpload,
  RECEIPT_UPLOAD,
  signReceiptUpload,
  verifyReceiptUpload,
} from '@gyblos/protocol/receipt-upload';
import {
  parseReceiptUploadV2,
  RECEIPT_UPLOAD_V2,
  signReceiptUploadV2,
  verifyReceiptUploadEnvelopeV2,
  verifyReceiptUploadV2,
  type ReceiptUploadV2,
} from '@gyblos/protocol/receipt-upload-v2';
import { sign } from '@gyblos/protocol/signing';

import {
  buyerUpload,
  clone,
  freePair,
  rejects,
  sellerUpload,
} from './support/receipt-upload';
import { referencedUpload } from './support/receipt-upload-v2';

void test('legacy uploads retain their original signing and verification behavior', async () => {
  const { seller, receipt } = await freePair();
  const signed = await signReceiptUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  assert.deepEqual(await verifyReceiptUpload(signed), signed);
});

void test('a buyer signs a paid upload with a declared exact-quote reference', async () => {
  const { buyer, upload } = await referencedUpload();
  await assert.doesNotReject(async () => {
    const signed = await signReceiptUploadV2(upload, buyer.sign);
    assert.deepEqual(await verifyReceiptUploadV2(signed), signed);
    assert.deepEqual(await verifyReceiptUploadEnvelopeV2(signed), signed);
    assert.equal(signed.upload.items[0]!.offer!.offerDigest, '34'.repeat(32));
  });
});

void test('v2 preserves null offer rules for seller, free and unavailable buyer metadata', async () => {
  const { seller, buyer, receipt } = await freePair();
  for (const [signer, original] of [
    [seller, sellerUpload(seller.nodeId, receipt)],
    [buyer, buyerUpload(buyer.nodeId, receipt)],
  ] as const) {
    const upload: ReceiptUploadV2 = {
      ...original,
      version: RECEIPT_UPLOAD_V2.version,
      items: original.items.map((item) => ({ ...item, offer: null })),
    };
    await assert.doesNotReject(async () => {
      const signed = await signReceiptUploadV2(upload, signer.sign);
      assert.deepEqual(await verifyReceiptUploadV2(signed), signed);
    });
  }
  const paid = await referencedUpload();
  paid.upload.items[0]!.offer = null;
  await assert.doesNotReject(signReceiptUploadV2(paid.upload, paid.buyer.sign));
});

void test('v2 requires a canonical digest whenever paid offer facts are present', async () => {
  const { upload } = await referencedUpload();
  for (const digest of [
    undefined,
    null,
    '',
    'AB'.repeat(32),
    'a'.repeat(63),
    'gg'.repeat(32),
  ]) {
    const invalid = clone(upload);
    Reflect.set(invalid.items[0]!.offer!, 'offerDigest', digest);
    if (digest === undefined)
      Reflect.deleteProperty(invalid.items[0]!.offer!, 'offerDigest');
    assert.throws(
      () => parseReceiptUploadV2(invalid),
      (error: unknown) =>
        error instanceof ControlError && error.code === CONTROL_CODES.INVALID,
    );
  }
});

void test('unknown fields and accessors are not lost during v2 normalization', async (t) => {
  const { upload } = await referencedUpload();
  const verify = t.mock.method(crypto.subtle, 'verify');
  const edits: ((value: ReceiptUploadV2) => void)[] = [
    (value) => Reflect.set(value, 'extra', null),
    (value) => Reflect.set(value.items[0]!, 'extra', null),
    (value) => Reflect.set(value.items[0]!.offer!, 'extra', null),
    (value) =>
      Reflect.set(value.items[0]!.offer!, 'endpoint', {
        relayUrl: 'https://private.example',
      }),
    (value) =>
      Reflect.set(value.items[0]!.receipt.seller.record, 'extra', null),
  ];
  for (const edit of edits) {
    const invalid = clone(upload);
    edit(invalid);
    await rejects(
      verifyReceiptUploadEnvelopeV2({
        upload: invalid,
        signature: '00'.repeat(64),
      }),
      CONTROL_CODES.INVALID,
    );
  }
  let reads = 0;
  const invalid = clone(upload);
  Object.defineProperty(invalid.items[0]!.offer!, 'offerDigest', {
    enumerable: true,
    get() {
      reads++;
      return '34'.repeat(32);
    },
  });
  await rejects(
    verifyReceiptUploadEnvelopeV2({
      upload: invalid,
      signature: '00'.repeat(64),
    }),
    CONTROL_CODES.INVALID,
  );
  assert.equal(reads, 0);
  assert.equal(verify.mock.callCount(), 0);
});

void test('tampering with the quote reference invalidates its upload signature', async () => {
  const { buyer, upload } = await referencedUpload();
  await assert.doesNotReject(async () => {
    const signed = await signReceiptUploadV2(upload, buyer.sign);
    signed.upload.items[0]!.offer!.offerDigest = '56'.repeat(32);
    await rejects(verifyReceiptUploadV2(signed), CONTROL_CODES.SIGNATURE);
  });
});

void test('envelope versions and signing domains cannot be substituted', async () => {
  const { buyer, upload } = await referencedUpload();
  const signature = Buffer.from(
    await sign(RECEIPT_UPLOAD.domain, upload, buyer.sign),
  ).toString('hex');
  await rejects(
    verifyReceiptUploadEnvelopeV2({ upload, signature }),
    CONTROL_CODES.SIGNATURE,
  );
  await rejects(
    verifyReceiptUpload({ upload, signature }),
    CONTROL_CODES.VERSION,
  );
  const { seller, receipt } = await freePair();
  const legacy = await signReceiptUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  await rejects(verifyReceiptUploadEnvelopeV2(legacy), CONTROL_CODES.VERSION);
  const invalid = clone(upload);
  Reflect.set(invalid, 'version', RECEIPT_UPLOAD.version);
  assert.throws(
    () => parseReceiptUpload(invalid),
    (error: unknown) =>
      error instanceof ControlError && error.code === CONTROL_CODES.INVALID,
  );
});

void test('v2 detaches quote claims and receipt halves before signature verification yields', async () => {
  const { buyer, upload } = await referencedUpload();
  await assert.doesNotReject(async () => {
    const signed = await signReceiptUploadV2(upload, buyer.sign);
    const input = clone(signed);
    const pending = verifyReceiptUploadV2(input);
    input.upload.items[0]!.offer!.offerDigest = '78'.repeat(32);
    input.upload.items[0]!.receipt.buyer!.record.observed.outputTokens = 999;
    assert.deepEqual(await pending, signed);
  });
});
