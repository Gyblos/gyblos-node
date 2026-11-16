// Protects the receipt upload envelope: uploader-signed batches of node receipts plus the uploader's
// own timestamps, bound to receipts the uploader is party to.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CODES } from '@gyblos/protocol/constants';
import { signSellerReceipt } from '@gyblos/protocol/receipt';
import {
  RECEIPT_UPLOAD,
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
  signReceiptUpload,
  verifyReceiptUpload,
  verifyReceiptUploadEnvelope,
  type ReceiptUploadV1,
  type SignedReceiptUpload,
} from '@gyblos/protocol/receipt-upload';
import { sign } from '@gyblos/protocol/signing';

import { receiptSigner, sellerRecord } from './support/receipt-fixture';
import {
  buyerUpload,
  clone,
  freePair,
  paidPair,
  rejects,
  sellerUpload,
  T0,
} from './support/receipt-upload';

void test('a seller signs an upload of its own free receipt and the collector verifies it', async () => {
  const { seller, receipt } = await freePair();
  const signed = await signReceiptUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  assert.deepEqual(await verifyReceiptUpload(clone(signed)), signed);
});

void test('a buyer uploads a paid v2 receipt with its start time and accepted offer facts', async () => {
  const { buyer, receipt } = await paidPair();
  const signed = await signReceiptUpload(
    buyerUpload(buyer.nodeId, receipt),
    buyer.sign,
  );
  const verified = await verifyReceiptUpload(clone(signed));
  assert.deepEqual(verified, signed);
  assert.equal(verified.upload.items[0]!.offer?.maxAtomic, '1000');
});

void test('changing any signed field after signing fails the envelope signature', async () => {
  const { seller, receipt } = await freePair();
  const signed = await signReceiptUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  const edits: ((upload: ReceiptUploadV1) => void)[] = [
    (u) => (u.sentAt += 1),
    (u) => (u.nonce = 'cd'.repeat(RECEIPT_UPLOAD.nonceBytes)),
    (u) => (u.client.appVersion = '0.1.0'),
    (u) => (u.client.platform = RECEIPT_UPLOAD_PLATFORMS.MACOS),
    (u) => (u.client.arch = RECEIPT_UPLOAD_ARCHES.ARM64),
    (u) => (u.items[0]!.storedAt = T0),
    (u) => (u.items[0]!.storedAt = null),
  ];
  for (const edit of edits) {
    const tampered = clone(signed);
    edit(tampered.upload);
    await rejects(verifyReceiptUpload(tampered), CONTROL_CODES.SIGNATURE);
  }

  const { buyer, receipt: paid } = await paidPair();
  const buyerSigned = await signReceiptUpload(
    buyerUpload(buyer.nodeId, paid),
    buyer.sign,
  );
  const buyerEdits: ((upload: ReceiptUploadV1) => void)[] = [
    (u) => (u.items[0]!.startedAt = T0 - 1),
    (u) => (u.items[0]!.offer!.maxAtomic = '2000'),
    (u) => (u.items[0]!.offer!.expiresAt += 1),
    (u) => (u.client.kind = RECEIPT_UPLOAD_CLIENTS.BUYER_CLI),
  ];
  for (const edit of buyerEdits) {
    const tampered = clone(buyerSigned);
    edit(tampered.upload);
    await rejects(verifyReceiptUpload(tampered), CONTROL_CODES.SIGNATURE);
  }
});

void test('verification detaches the envelope before signature checks yield', async () => {
  const { seller, receipt } = await freePair();
  const signed = await signReceiptUpload(
    sellerUpload(seller.nodeId, receipt),
    seller.sign,
  );
  const input = clone(signed);
  const pending = verifyReceiptUpload(input);
  input.upload.sentAt = 1;
  input.upload.items[0]!.storedAt = 2;
  input.upload.items[0]!.receipt.seller.record.usage.outputTokens = 999;
  assert.deepEqual(await pending, signed);
});

void test('an uploader can only upload receipts it is party to in its role', async () => {
  const { seller, buyer, receipt } = await freePair();
  const outsider = receiptSigner();
  for (const [signer, upload] of [
    [outsider, sellerUpload(outsider.nodeId, receipt)],
    [buyer, sellerUpload(buyer.nodeId, receipt)],
    [seller, { ...buyerUpload(seller.nodeId, receipt) }],
  ] as const) {
    await rejects(signReceiptUpload(upload, signer.sign), CONTROL_CODES.POLICY);
    // A hand-signed envelope is refused before any receipt signature is checked.
    const forged: SignedReceiptUpload = {
      upload,
      signature: Buffer.from(
        await sign(RECEIPT_UPLOAD.domain, upload, signer.sign),
      ).toString('hex'),
    };
    await rejects(verifyReceiptUpload(forged), CONTROL_CODES.POLICY);
  }
});

void test('offer facts must be coherent and cover the seller-signed amount', async () => {
  const { buyer, receipt } = await paidPair();
  const reversed = buyerUpload(buyer.nodeId, receipt);
  reversed.items[0]!.offer!.expiresAt = reversed.items[0]!.offer!.issuedAt - 1;
  await rejects(signReceiptUpload(reversed, buyer.sign), CONTROL_CODES.INVALID);

  const noTokens = buyerUpload(buyer.nodeId, receipt);
  noTokens.items[0]!.offer!.maxTokens = 0;
  await rejects(signReceiptUpload(noTokens, buyer.sign), CONTROL_CODES.INVALID);

  const below = buyerUpload(buyer.nodeId, receipt);
  below.items[0]!.offer!.maxAtomic = '69';
  await rejects(signReceiptUpload(below, buyer.sign), CONTROL_CODES.POLICY);

  const withoutOffer = buyerUpload(buyer.nodeId, receipt);
  withoutOffer.items[0]!.offer = null;
  const signed = await signReceiptUpload(withoutOffer, buyer.sign);
  assert.deepEqual(await verifyReceiptUpload(clone(signed)), signed);
});

void test('exactly the maximum number of distinct receipts is accepted', async () => {
  const seller = receiptSigner();
  const items: ReceiptUploadV1['items'] = [];
  for (let index = 0; index < RECEIPT_UPLOAD.maxItems; index++) {
    const record = {
      ...sellerRecord(seller.nodeId, receiptSigner().nodeId),
      requestId: index.toString(16).padStart(32, '0'),
    };
    items.push({
      receipt: { seller: await signSellerReceipt(record, seller.sign) },
      storedAt: null,
      startedAt: null,
      offer: null,
    });
  }
  const upload = { ...sellerUpload(seller.nodeId, items[0]!.receipt), items };
  const signed = await signReceiptUpload(upload, seller.sign);
  assert.equal(
    (await verifyReceiptUpload(clone(signed))).upload.items.length,
    RECEIPT_UPLOAD.maxItems,
  );
});

void test('the envelope-only check verifies the uploader signature but leaves receipts to the caller', async () => {
  const { seller, receipt } = await freePair();
  const broken = clone(receipt);
  broken.seller.record.usage.outputTokens += 1;
  const signed = await signReceiptUpload(
    sellerUpload(seller.nodeId, broken),
    seller.sign,
  );
  assert.deepEqual(await verifyReceiptUploadEnvelope(clone(signed)), signed);
  await rejects(verifyReceiptUpload(clone(signed)), CONTROL_CODES.SIGNATURE);
  const tampered = clone(signed);
  tampered.upload.sentAt += 1;
  await rejects(verifyReceiptUploadEnvelope(tampered), CONTROL_CODES.SIGNATURE);
});
