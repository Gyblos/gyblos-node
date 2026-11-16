// Versioned receipt upload contract with an exact-quote reference; no uploader or collector wiring.
import { controlFail } from './control-validation';
import type {
  ReceiptUploadOfferV2,
  ReceiptUploadV2,
  SignedReceiptUploadV2,
} from './receipt-upload-v2-types';
import type { Signer } from './signing';

export type * from './receipt-upload-v2-types';
export { RECEIPT_UPLOAD_V2 } from './receipt-upload/constants';

export async function buildReceiptUploadOfferV2(
  value: unknown,
): Promise<ReceiptUploadOfferV2> {
  void value;
  return controlFail();
}

export function parseReceiptUploadV2(value: unknown): ReceiptUploadV2 {
  void value;
  return controlFail();
}
export async function signReceiptUploadV2(
  value: ReceiptUploadV2,
  signer: Signer,
): Promise<SignedReceiptUploadV2> {
  void value;
  void signer;
  return controlFail();
}
export async function verifyReceiptUploadEnvelopeV2(
  value: unknown,
): Promise<SignedReceiptUploadV2> {
  void value;
  return controlFail();
}
export async function verifyReceiptUploadV2(
  value: unknown,
): Promise<SignedReceiptUploadV2> {
  void value;
  return controlFail();
}
