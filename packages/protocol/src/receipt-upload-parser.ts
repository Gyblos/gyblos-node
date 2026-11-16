// Parses the receipt upload envelope strictly; receipts are parsed by their own version's parser and
// their node signatures are verified separately.
import { canonicalJson } from './canonical';
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
  RECEIPT,
  type P2PRole,
} from './constants';
import {
  controlArray,
  controlAtomic,
  controlFail,
  controlHex,
  controlInteger,
  controlObject,
} from './control-validation';
import { parseBuyerReceipt, parseSellerReceipt } from './receipt-parser';
import type { ReceiptV1 } from './receipt-types';
import type {
  ReceiptUploadClient,
  ReceiptUploadItem,
  ReceiptUploadOffer,
  ReceiptUploadV1,
} from './receipt-upload-types';
import {
  RECEIPT_UPLOAD,
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
  type ReceiptUploadClientKind,
} from './receipt-upload/constants';
import { parseBuyerReceiptV2, parseSellerReceiptV2 } from './receipt-v2-parser';
import type { ReceiptV2 } from './receipt-v2-types';
import { RECEIPT_V2 } from './receipt-v2/constants';

function closed<T extends string>(
  value: unknown,
  catalog: Record<string, T>,
): T {
  for (const item of Object.values(catalog)) if (value === item) return item;
  return controlFail();
}
function time(value: unknown) {
  return controlInteger(value);
}
function optionalTime(value: unknown) {
  return value === null ? null : time(value);
}
function role(value: unknown): P2PRole {
  return closed(value, P2P_ROLES);
}
function clientRole(kind: ReceiptUploadClientKind): P2PRole {
  return kind === RECEIPT_UPLOAD_CLIENTS.SELLER_NODE
    ? P2P_ROLES.SELLER
    : P2P_ROLES.BUYER;
}
function appVersion(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > RECEIPT_UPLOAD.maxAppVersionCharacters ||
    !/^[0-9A-Za-z.+-]+$/.test(value)
  )
    return controlFail();
  return value;
}
function client(value: unknown): ReceiptUploadClient {
  const input = controlObject(value, [
    'kind',
    'appVersion',
    'platform',
    'arch',
  ]);
  return {
    kind: closed(input.kind, RECEIPT_UPLOAD_CLIENTS),
    appVersion: appVersion(input.appVersion),
    platform: closed(input.platform, RECEIPT_UPLOAD_PLATFORMS),
    arch: closed(input.arch, RECEIPT_UPLOAD_ARCHES),
  };
}
function offer(value: unknown): ReceiptUploadOffer | null {
  if (value === null) return null;
  const input = controlObject(value, [
    'issuedAt',
    'expiresAt',
    'maxAtomic',
    'maxTokens',
    'observedAt',
    'catalogDigest',
  ]);
  const parsed = {
    issuedAt: time(input.issuedAt),
    expiresAt: time(input.expiresAt),
    maxAtomic: controlAtomic(input.maxAtomic),
    maxTokens: controlInteger(input.maxTokens, 1),
    observedAt: time(input.observedAt),
    catalogDigest: controlHex(input.catalogDigest),
  };
  if (parsed.expiresAt < parsed.issuedAt) return controlFail();
  return parsed;
}
function signedHalf<T>(value: unknown, parse: (record: unknown) => T) {
  const input = controlObject(value, ['record', 'signature']);
  return {
    record: parse(input.record),
    signature: controlHex(input.signature, CONTROL_LIMITS.signatureBytes),
  };
}
// Parses a receipt by its seller record's version without verifying node signatures.
function receipt(value: unknown): ReceiptV1 | ReceiptV2 {
  const hasBuyer =
    !!value && typeof value === 'object' && Object.hasOwn(value, 'buyer');
  const input = controlObject(value, [
    'seller',
    ...(hasBuyer ? ['buyer'] : []),
  ]);
  const seller = controlObject(input.seller, ['record', 'signature']);
  if (!seller.record || typeof seller.record !== 'object') return controlFail();
  // Validate descriptors before reading the version, as the v2 parser does.
  const { version } = controlObject(seller.record, Object.keys(seller.record));
  if (version === RECEIPT.version) {
    const parsed: ReceiptV1 = {
      seller: signedHalf(input.seller, parseSellerReceipt),
    };
    if (hasBuyer) parsed.buyer = signedHalf(input.buyer, parseBuyerReceipt);
    return parsed;
  }
  if (version === RECEIPT_V2.version) {
    const parsed: ReceiptV2 = {
      seller: signedHalf(input.seller, parseSellerReceiptV2),
    };
    if (hasBuyer) parsed.buyer = signedHalf(input.buyer, parseBuyerReceiptV2);
    return parsed;
  }
  return controlFail(CONTROL_CODES.VERSION);
}
function item(value: unknown, uploaderRole: P2PRole): ReceiptUploadItem {
  const input = controlObject(value, [
    'receipt',
    'storedAt',
    'startedAt',
    'offer',
  ]);
  const parsed: ReceiptUploadItem = {
    receipt: receipt(input.receipt),
    storedAt: optionalTime(input.storedAt),
    startedAt: optionalTime(input.startedAt),
    offer: offer(input.offer),
  };
  if (
    uploaderRole === P2P_ROLES.SELLER &&
    (parsed.startedAt !== null || parsed.offer !== null)
  )
    return controlFail();
  const record = parsed.receipt.seller.record;
  if (parsed.offer !== null) {
    if (record.pricing.kind !== OFFER_PRICING_KINDS.PAID) return controlFail();
    // The offer is the buyer's claim; it must at least cover the seller-signed amount.
    if (BigInt(record.amountAtomic) > BigInt(parsed.offer.maxAtomic))
      return controlFail(CONTROL_CODES.POLICY);
  }
  return parsed;
}
// The uploader must be the receipt's seller (seller role) or its buyer (buyer role). Checked while
// parsing, before any signature work.
function party(
  value: ReceiptV1 | ReceiptV2,
  uploaderNodeId: string,
  uploaderRole: P2PRole,
) {
  const record = value.seller.record;
  return uploaderRole === P2P_ROLES.SELLER
    ? record.sellerNodeId === uploaderNodeId
    : record.buyerNodeId === uploaderNodeId;
}
function receiptKey(value: ReceiptV1 | ReceiptV2) {
  const record = value.seller.record;
  return canonicalJson([
    record.sellerNodeId,
    record.buyerNodeId,
    record.requestId,
  ]);
}

export function parseReceiptUpload(value: unknown): ReceiptUploadV1 {
  if (!value || typeof value !== 'object') return controlFail();
  const input = controlObject(value, [
    'version',
    'uploaderNodeId',
    'role',
    'client',
    'sentAt',
    'nonce',
    'items',
  ]);
  if (input.version !== RECEIPT_UPLOAD.version)
    return controlFail(CONTROL_CODES.VERSION);
  const uploaderNodeId = controlHex(input.uploaderNodeId);
  const uploaderRole = role(input.role);
  const uploaderClient = client(input.client);
  if (clientRole(uploaderClient.kind) !== uploaderRole) return controlFail();
  const rawItems = controlArray(input.items, RECEIPT_UPLOAD.maxItems);
  if (!rawItems.length) return controlFail();
  const items = rawItems.map((entry) => item(entry, uploaderRole));
  for (const entry of items)
    if (!party(entry.receipt, uploaderNodeId, uploaderRole))
      return controlFail(CONTROL_CODES.POLICY);
  const keys = new Set(items.map((entry) => receiptKey(entry.receipt)));
  if (keys.size !== items.length) return controlFail();
  const upload: ReceiptUploadV1 = {
    version: RECEIPT_UPLOAD.version,
    uploaderNodeId,
    role: uploaderRole,
    client: uploaderClient,
    sentAt: time(input.sentAt),
    nonce: controlHex(input.nonce, RECEIPT_UPLOAD.nonceBytes),
    items,
  };
  if (
    new TextEncoder().encode(canonicalJson(upload)).byteLength >
    RECEIPT_UPLOAD.maxBytes
  )
    return controlFail(CONTROL_CODES.LIMIT);
  return upload;
}
