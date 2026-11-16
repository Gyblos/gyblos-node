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
// Facts of the paid offer the buyer accepted. The full signed offer is not uploaded: it carries the
// seller's endpoint addresses, which the collector must never store.
export interface ReceiptUploadOffer {
  issuedAt: number;
  expiresAt: number;
  maxAtomic: string;
  maxTokens: number;
  observedAt: number;
  catalogDigest: string;
}
// Times are the uploader's own clock, in milliseconds since epoch. They are attested by the
// uploader's envelope signature only, never by the peer.
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
