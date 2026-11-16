// Synthetic receipt upload envelopes over ephemeral node signers; never product keys or content.
import assert from 'node:assert/strict';

import { OFFER_PRICING_KINDS, P2P_ROLES } from '@gyblos/protocol/constants';
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
  type ReceiptUploadV1,
} from '@gyblos/protocol/receipt-upload';
import {
  sellerReceiptDigestV2,
  signBuyerReceiptV2,
  signSellerReceiptV2,
  type ReceiptV2,
} from '@gyblos/protocol/receipt-v2';

import { buyerRecord, receiptSigner, sellerRecord } from './receipt-fixture';
import { paidBuyerRecord, paidReceiptFixture } from './receipt-v2';

export const T0 = 1_800_000_000_000;

export async function freePair(
  seller = receiptSigner(),
  buyer = receiptSigner(),
) {
  const record = sellerRecord(seller.nodeId, buyer.nodeId);
  const signed = await signSellerReceipt(record, seller.sign);
  const confirmation = await signBuyerReceipt(
    buyerRecord(record, await sellerReceiptDigest(record)),
    buyer.sign,
  );
  const receipt: ReceiptV1 = { seller: signed, buyer: confirmation };
  return { seller, buyer, receipt };
}

export async function paidPair() {
  const { seller, buyer, record } = paidReceiptFixture();
  const signed = await signSellerReceiptV2(record, seller.sign);
  const confirmation = await signBuyerReceiptV2(
    paidBuyerRecord(record, await sellerReceiptDigestV2(record)),
    buyer.sign,
  );
  const receipt: ReceiptV2 = { seller: signed, buyer: confirmation };
  return { seller, buyer, receipt };
}

export function sellerUpload(
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

export function buyerUpload(
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

export async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ControlError && error.code === code,
  );
}

export const clone = <T>(value: T): T => structuredClone(value);
