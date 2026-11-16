// Versioned receipt upload contract with an exact-quote reference; no uploader or collector wiring.
import { CONTROL_CODES, CONTROL_LIMITS, RECEIPT } from './constants';
import {
  controlFail,
  controlHex,
  controlObject,
  controlVerify,
} from './control-validation';
import { offerDigestV2, parseOfferV2 } from './offer-v2';
import { bytesHex, hexBytes } from './public-validation';
import { verifyReceipt } from './receipt';
import { parseReceiptUploadV2 } from './receipt-upload-v2-parser';
import type {
  ReceiptUploadOfferV2,
  ReceiptUploadV2,
  SignedReceiptUploadV2,
} from './receipt-upload-v2-types';
import { RECEIPT_UPLOAD_V2 } from './receipt-upload/constants';
import { verifyReceiptV2 } from './receipt-v2';
import { sign, type Signer } from './signing';

export type * from './receipt-upload-v2-types';
export { RECEIPT_UPLOAD_V2 } from './receipt-upload/constants';
export { parseReceiptUploadV2 };

// Callers verify the quote and associate it with execution first. Returns no endpoint or signature.
export async function buildReceiptUploadOfferV2(
  value: unknown,
): Promise<ReceiptUploadOfferV2> {
  const offer = parseOfferV2(value);
  if (offer.expiresAt < offer.issuedAt) return controlFail();
  return {
    issuedAt: offer.issuedAt,
    expiresAt: offer.expiresAt,
    maxAtomic: offer.maxAtomic,
    maxTokens: offer.maxTokens,
    observedAt: offer.availability.observedAt,
    catalogDigest: offer.catalogDigest,
    offerDigest: await offerDigestV2(offer),
  };
}

export async function signReceiptUploadV2(
  value: ReceiptUploadV2,
  signer: Signer,
): Promise<SignedReceiptUploadV2> {
  const upload = parseReceiptUploadV2(value);
  const signature = Uint8Array.from(
    await sign(RECEIPT_UPLOAD_V2.domain, upload, signer),
  );
  if (signature.length !== CONTROL_LIMITS.signatureBytes)
    return controlFail(CONTROL_CODES.SIGNATURE);
  return verifyReceiptUploadEnvelopeV2({
    upload,
    signature: bytesHex(signature),
  });
}
// Envelope admission only: receipt signatures must still be verified/classified by the collector.
export async function verifyReceiptUploadEnvelopeV2(
  value: unknown,
): Promise<SignedReceiptUploadV2> {
  const input = controlObject(value, ['upload', 'signature']);
  const upload = parseReceiptUploadV2(input.upload);
  const signature = controlHex(input.signature, CONTROL_LIMITS.signatureBytes);
  if (
    !(await controlVerify(
      RECEIPT_UPLOAD_V2.domain,
      upload,
      hexBytes(upload.uploaderNodeId),
      hexBytes(signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { upload, signature };
}
export async function verifyReceiptUploadV2(
  value: unknown,
): Promise<SignedReceiptUploadV2> {
  const signed = await verifyReceiptUploadEnvelopeV2(value);
  for (const item of signed.upload.items) {
    if (item.receipt.seller.record.version === RECEIPT.version)
      await verifyReceipt(item.receipt);
    else await verifyReceiptV2(item.receipt);
  }
  return signed;
}
