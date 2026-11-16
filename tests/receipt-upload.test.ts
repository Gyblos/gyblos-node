// Protects the receipt upload envelope: uploader-signed batches of node receipts plus the uploader's
// own unsigned-by-peer timestamps, bound to receipts the uploader is party to.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTROL_CODES,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  RECEIPT,
} from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import {
  sellerReceiptDigest,
  signBuyerReceipt,
  signSellerReceipt,
  type ReceiptV1,
} from '@gyblos/protocol/receipt';
import {
  RECEIPT_UPLOAD,
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
  signReceiptUpload,
  verifyReceiptUpload,
  type ReceiptUploadV1,
  type SignedReceiptUpload,
} from '@gyblos/protocol/receipt-upload';
import {
  RECEIPT_V2,
  sellerReceiptDigestV2,
  signBuyerReceiptV2,
  signSellerReceiptV2,
  type ReceiptV2,
} from '@gyblos/protocol/receipt-v2';
import { sign } from '@gyblos/protocol/signing';

import {
  buyerRecord,
  receiptSigner,
  sellerRecord,
} from './support/receipt-fixture';
import { paidBuyerRecord, paidReceiptFixture } from './support/receipt-v2';

const T0 = 1_800_000_000_000;

async function freePair(seller = receiptSigner(), buyer = receiptSigner()) {
  const record = sellerRecord(seller.nodeId, buyer.nodeId);
  const signed = await signSellerReceipt(record, seller.sign);
  const confirmation = await signBuyerReceipt(
    buyerRecord(record, await sellerReceiptDigest(record)),
    buyer.sign,
  );
  const receipt: ReceiptV1 = { seller: signed, buyer: confirmation };
  return { seller, buyer, receipt };
}

async function paidPair() {
  const { seller, buyer, record } = paidReceiptFixture();
  const signed = await signSellerReceiptV2(record, seller.sign);
  const confirmation = await signBuyerReceiptV2(
    paidBuyerRecord(record, await sellerReceiptDigestV2(record)),
    buyer.sign,
  );
  const receipt: ReceiptV2 = { seller: signed, buyer: confirmation };
  return { seller, buyer, receipt };
}

function sellerUpload(
  uploaderNodeId: string,
  receipt: ReceiptV1 | ReceiptV2,
): ReceiptUploadV1 {
  return {
    version: RECEIPT_UPLOAD.version,
    uploaderNodeId,
    role: P2P_ROLES.SELLER,
    client: {
      kind: RECEIPT_UPLOAD_CLIENTS.SELLER_NODE,
      appVersion: '0.1.0-beta.11',
      platform: RECEIPT_UPLOAD_PLATFORMS.LINUX,
      arch: RECEIPT_UPLOAD_ARCHES.X64,
    },
    sentAt: T0,
    nonce: 'ab'.repeat(RECEIPT_UPLOAD.nonceBytes),
    items: [{ receipt, storedAt: T0 - 1000, startedAt: null, offer: null }],
  };
}

function buyerUpload(
  uploaderNodeId: string,
  receipt: ReceiptV1 | ReceiptV2,
): ReceiptUploadV1 {
  const paid = receipt.seller.record.pricing.kind === OFFER_PRICING_KINDS.PAID;
  return {
    ...sellerUpload(uploaderNodeId, receipt),
    role: P2P_ROLES.BUYER,
    client: {
      kind: RECEIPT_UPLOAD_CLIENTS.BUYER_DESKTOP,
      appVersion: '0.1.0-beta.11',
      platform: RECEIPT_UPLOAD_PLATFORMS.MACOS,
      arch: RECEIPT_UPLOAD_ARCHES.ARM64,
    },
    items: [
      {
        receipt,
        storedAt: T0 - 900,
        startedAt: T0 - 2000,
        offer: paid
          ? {
              issuedAt: T0 - 2100,
              expiresAt: T0 + 28_000,
              maxAtomic: '1000',
              maxTokens: 512,
              observedAt: T0 - 2100,
              catalogDigest: '55'.repeat(32),
            }
          : null,
      },
    ],
  };
}

async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ControlError && error.code === code,
  );
}

const clone = <T>(value: T): T => structuredClone(value);

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
