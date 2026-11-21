// Protects the receipt upload envelope's structural rules: per-role fields, client kinds, item
// bounds, unknown keys, versions and its separate signing domain.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CODES, RECEIPT } from '@gyblos/protocol/constants';
import {
  isReceiptUploadAppVersion,
  RECEIPT_UPLOAD,
  RECEIPT_UPLOAD_CLIENTS,
  signReceiptUpload,
  verifyReceiptUpload,
  type ReceiptUploadV1,
} from '@gyblos/protocol/receipt-upload';
import { RECEIPT_V2 } from '@gyblos/protocol/receipt-v2';

import {
  buyerUpload,
  clone,
  freePair,
  paidPair,
  rejects,
  sellerUpload,
  T0,
} from './support/receipt-upload';

void test('a receipt with a bad node signature is refused inside a valid envelope', async () => {
  const { seller, receipt } = await freePair();
  const broken = clone(receipt);
  broken.seller.record.usage.outputTokens += 1;
  const signed = await signReceiptUpload(
    sellerUpload(seller.nodeId, broken),
    seller.sign,
  );
  await rejects(verifyReceiptUpload(signed), CONTROL_CODES.SIGNATURE);
});

void test('sellers carry no buyer timing or offer; offers belong only to paid receipts', async () => {
  const { seller, buyer, receipt } = await freePair();
  const sellerWithStart = sellerUpload(seller.nodeId, receipt);
  sellerWithStart.items[0]!.startedAt = T0 - 5;
  await rejects(
    signReceiptUpload(sellerWithStart, seller.sign),
    CONTROL_CODES.INVALID,
  );
  const freeWithOffer = buyerUpload(buyer.nodeId, receipt);
  freeWithOffer.items[0]!.offer = {
    issuedAt: T0,
    expiresAt: T0 + 1,
    maxAtomic: '1',
    maxTokens: 1,
    observedAt: T0,
    catalogDigest: '55'.repeat(32),
  };
  await rejects(
    signReceiptUpload(freeWithOffer, buyer.sign),
    CONTROL_CODES.INVALID,
  );
});

void test('the client kind must match the uploader role', async () => {
  const { seller, receipt } = await freePair();
  const upload = sellerUpload(seller.nodeId, receipt);
  upload.client.kind = RECEIPT_UPLOAD_CLIENTS.BUYER_CLI;
  await rejects(signReceiptUpload(upload, seller.sign), CONTROL_CODES.INVALID);
});

void test('one envelope carries one copy of each receipt and a bounded number of items', async () => {
  const { seller, receipt } = await freePair();
  const duplicate = sellerUpload(seller.nodeId, receipt);
  duplicate.items.push(clone(duplicate.items[0]!));
  await rejects(
    signReceiptUpload(duplicate, seller.sign),
    CONTROL_CODES.INVALID,
  );

  const empty = sellerUpload(seller.nodeId, receipt);
  empty.items = [];
  await rejects(signReceiptUpload(empty, seller.sign), CONTROL_CODES.INVALID);

  const many = sellerUpload(seller.nodeId, receipt);
  many.items = Array.from({ length: RECEIPT_UPLOAD.maxItems + 1 }, () =>
    clone(many.items[0]!),
  );
  await rejects(signReceiptUpload(many, seller.sign), CONTROL_CODES.INVALID);
});

void test('unknown fields, foreign versions and malformed values are refused with static codes', async () => {
  const { seller, receipt } = await freePair();
  const signed = await signReceiptUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  const extra = clone(signed) as unknown as { upload: Record<string, unknown> };
  extra.upload.ip = '203.0.113.1';
  await rejects(verifyReceiptUpload(extra), CONTROL_CODES.INVALID);

  const version = clone(signed) as unknown as {
    upload: Record<string, unknown>;
  };
  version.upload.version = 2;
  await rejects(verifyReceiptUpload(version), CONTROL_CODES.VERSION);

  for (const patch of [
    { sentAt: -1 },
    { sentAt: 1.5 },
    { nonce: 'ab' },
    { uploaderNodeId: 'zz' },
  ]) {
    const bad = {
      ...clone(signed),
      upload: { ...clone(signed).upload, ...patch },
    };
    await rejects(verifyReceiptUpload(bad), CONTROL_CODES.INVALID);
  }

  for (const target of ['client', 'item', 'offer'] as const) {
    const { buyer, receipt: paid } = await paidPair();
    const extraField = buyerUpload(buyer.nodeId, paid) as unknown as {
      client: Record<string, unknown>;
      items: (Record<string, unknown> & { offer: Record<string, unknown> })[];
    };
    if (target === 'client') extraField.client.ip = '203.0.113.1';
    if (target === 'item') extraField.items[0]!.endpoint = 'relay';
    if (target === 'offer') extraField.items[0]!.offer.directAddresses = [];
    await rejects(
      signReceiptUpload(extraField as unknown as ReceiptUploadV1, buyer.sign),
      CONTROL_CODES.INVALID,
    );
  }

  const sellerOffer = sellerUpload(seller.nodeId, receipt);
  sellerOffer.items[0]!.offer = {
    issuedAt: T0,
    expiresAt: T0 + 1,
    maxAtomic: '1',
    maxTokens: 1,
    observedAt: T0,
    catalogDigest: '55'.repeat(32),
  };
  await rejects(
    signReceiptUpload(sellerOffer, seller.sign),
    CONTROL_CODES.INVALID,
  );

  const foreignReceipt = clone(signed) as unknown as {
    upload: {
      items: { receipt: { seller: { record: Record<string, unknown> } } }[];
    };
  };
  foreignReceipt.upload.items[0]!.receipt.seller.record.version = 3;
  await rejects(verifyReceiptUpload(foreignReceipt), CONTROL_CODES.VERSION);

  const notObject = clone(signed) as unknown as {
    upload: { items: { receipt: { seller: { record: unknown } } }[] };
  };
  notObject.upload.items[0]!.receipt.seller.record = 'record';
  await rejects(verifyReceiptUpload(notObject), CONTROL_CODES.INVALID);

  const appVersion = clone(signed);
  appVersion.upload.client.appVersion = 'x'.repeat(
    RECEIPT_UPLOAD.maxAppVersionCharacters + 1,
  );
  await rejects(verifyReceiptUpload(appVersion), CONTROL_CODES.INVALID);
});

void test('the envelope signing domain is separate from every receipt domain', () => {
  assert.equal(RECEIPT_UPLOAD.domain, 'gyblos/receipt-upload/v1\n');
  for (const domain of [
    RECEIPT.sellerDomain,
    RECEIPT.buyerDomain,
    RECEIPT_V2.sellerDomain,
    RECEIPT_V2.buyerDomain,
  ])
    assert.notEqual(RECEIPT_UPLOAD.domain, domain);
});

void test('the app version rule accepts release tags and refuses anything else', () => {
  const longest = '1'.repeat(RECEIPT_UPLOAD.maxAppVersionCharacters);
  for (const version of ['0.1.0', '1.2.3-beta.4+build', longest])
    assert.equal(isReceiptUploadAppVersion(version), true, version);
  for (const version of ['', `${longest}1`, '1.0\n', '1.0 ', '1/0', 'ñ'])
    assert.equal(isReceiptUploadAppVersion(version), false, version);
});
