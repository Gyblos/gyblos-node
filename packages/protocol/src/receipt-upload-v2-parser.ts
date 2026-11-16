// Validates the v2 extension before delegating unchanged receipt/metadata rules to v1.
// Only offerDigest is stripped for normalization; unknown fields remain invalid.
import { canonicalJson } from './canonical';
import { CONTROL_CODES } from './constants';
import {
  controlArray,
  controlFail,
  controlHex,
  controlObject,
} from './control-validation';
import { parseReceiptUpload } from './receipt-upload-parser';
import type { ReceiptUploadV2 } from './receipt-upload-v2-types';
import { RECEIPT_UPLOAD, RECEIPT_UPLOAD_V2 } from './receipt-upload/constants';

function ownDataObject(value: unknown) {
  if (!value || typeof value !== 'object') return controlFail();
  return controlObject(value, Object.keys(value));
}

function normalizeItem(value: unknown) {
  const item = ownDataObject(value);
  if (item.offer === null) return { item, offerDigest: null };
  const offer = controlObject(item.offer, [
    'issuedAt',
    'expiresAt',
    'maxAtomic',
    'maxTokens',
    'observedAt',
    'catalogDigest',
    'offerDigest',
  ]);
  const { offerDigest, ...facts } = offer;
  return {
    item: { ...item, offer: facts },
    offerDigest: controlHex(offerDigest),
  };
}

export function parseReceiptUploadV2(value: unknown): ReceiptUploadV2 {
  const input = ownDataObject(value);
  if (input.version !== RECEIPT_UPLOAD_V2.version)
    return controlFail(CONTROL_CODES.VERSION);
  const items = controlArray(input.items, RECEIPT_UPLOAD_V2.maxItems).map(
    normalizeItem,
  );
  const parsed = parseReceiptUpload({
    ...input,
    version: RECEIPT_UPLOAD.version,
    items: items.map((entry) => entry.item),
  });
  const upload: ReceiptUploadV2 = {
    ...parsed,
    version: RECEIPT_UPLOAD_V2.version,
    items: parsed.items.map((item, index) => ({
      ...item,
      offer:
        item.offer === null
          ? null
          : {
              ...item.offer,
              offerDigest: controlHex(items[index]!.offerDigest),
            },
    })),
  };
  if (
    new TextEncoder().encode(canonicalJson(upload)).byteLength >
    RECEIPT_UPLOAD_V2.maxBytes
  )
    return controlFail(CONTROL_CODES.LIMIT);
  return upload;
}
