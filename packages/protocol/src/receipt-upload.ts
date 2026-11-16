// Receipt upload envelope contract: a node signs a batch of receipts it is party to, plus its own
// timestamps. The envelope signature attests the uploader's claims; each receipt keeps and is checked
// against its own node signatures. Freshness, replay and storage belong to the collector.
import { CONTROL_CODES, CONTROL_LIMITS, RECEIPT } from './constants';
import {
  controlFail,
  controlHex,
  controlObject,
  controlVerify,
} from './control-validation';
import { bytesHex, hexBytes } from './public-validation';
import { verifyReceipt } from './receipt';
import type { ReceiptV1 } from './receipt-types';
import { parseReceiptUpload } from './receipt-upload-parser';
import type {
  ReceiptUploadV1,
  SignedReceiptUpload,
} from './receipt-upload-types';
import { RECEIPT_UPLOAD } from './receipt-upload/constants';
import { verifyReceiptV2 } from './receipt-v2';
import type { ReceiptV2 } from './receipt-v2-types';
import { sign, type Signer } from './signing';

export type * from './receipt-upload-types';
export { parseReceiptUpload };
export {
  RECEIPT_UPLOAD,
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
} from './receipt-upload/constants';

export async function signReceiptUpload(
  value: ReceiptUploadV1,
  signer: Signer,
): Promise<SignedReceiptUpload> {
  const upload = parseReceiptUpload(value);
  const signature = Uint8Array.from(
    await sign(RECEIPT_UPLOAD.domain, upload, signer),
  );
  if (
    signature.length !== CONTROL_LIMITS.signatureBytes ||
    !(await controlVerify(
      RECEIPT_UPLOAD.domain,
      upload,
      hexBytes(upload.uploaderNodeId),
      signature,
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { upload, signature: bytesHex(signature) };
}

function verifyNodeReceipt(value: ReceiptV1 | ReceiptV2) {
  return value.seller.record.version === RECEIPT.version
    ? verifyReceipt(value)
    : verifyReceiptV2(value);
}

export async function verifyReceiptUpload(
  value: unknown,
): Promise<SignedReceiptUpload> {
  const input = controlObject(value, ['upload', 'signature']);
  // Parse and detach everything before any crypto yields; later caller mutation changes nothing.
  const upload = parseReceiptUpload(input.upload);
  const signature = controlHex(input.signature, CONTROL_LIMITS.signatureBytes);
  if (
    !(await controlVerify(
      RECEIPT_UPLOAD.domain,
      upload,
      hexBytes(upload.uploaderNodeId),
      hexBytes(signature),
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  // Party binding and every structural rule were checked by the parser, before any crypto.
  for (const item of upload.items) await verifyNodeReceipt(item.receipt);
  return { upload, signature };
}
