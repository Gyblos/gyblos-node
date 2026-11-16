// Types of the uploader-signed receipt envelope; receipts keep their own node signatures.
import type { P2PRole } from './constants';
import type { ReceiptV1 } from './receipt-types';
import type {
  RECEIPT_UPLOAD,
  ReceiptUploadArch,
  ReceiptUploadClientKind,
  ReceiptUploadPlatform,
} from './receipt-upload/constants';
import type { ReceiptV2 } from './receipt-v2-types';

export interface ReceiptUploadClient {
  kind: ReceiptUploadClientKind;
  appVersion: string;
  platform: ReceiptUploadPlatform;
  arch: ReceiptUploadArch;
}
// Buyer-reported facts of the accepted paid quote. Its timestamps originate on the seller's clock.
// The full signed offer is not uploaded: it carries endpoint addresses the collector must not store.
export interface ReceiptUploadOffer {
  issuedAt: number;
  expiresAt: number;
  maxAtomic: string;
  maxTokens: number;
  observedAt: number;
  catalogDigest: string;
}
// storedAt/startedAt use the uploader's clock; copied offer times use the seller's source clock.
// All are uploader claims in milliseconds since epoch, attested only by the envelope signature.
export interface ReceiptUploadItem {
  receipt: ReceiptV1 | ReceiptV2;
  // When the uploader's private store first kept this receipt; null when unknown.
  storedAt: number | null;
  // Buyer only: when the buyer sent the request. Always null from a seller.
  startedAt: number | null;
  // Buyer only, paid receipts only.
  offer: ReceiptUploadOffer | null;
}
export interface ReceiptUploadV1 {
  version: typeof RECEIPT_UPLOAD.version;
  uploaderNodeId: string;
  role: P2PRole;
  client: ReceiptUploadClient;
  sentAt: number;
  nonce: string;
  items: ReceiptUploadItem[];
}
export interface SignedReceiptUpload {
  upload: ReceiptUploadV1;
  signature: string;
}
