// Receipt-upload/v2 extends buyer paid-offer claims; existing receipt records stay unchanged.
import type {
  ReceiptUploadItem,
  ReceiptUploadOffer,
  ReceiptUploadV1,
} from './receipt-upload-types';
import type { RECEIPT_UPLOAD_V2 } from './receipt-upload/constants';

export interface ReceiptUploadOfferV2 extends ReceiptUploadOffer {
  offerDigest: string;
}
export interface ReceiptUploadItemV2 extends Omit<ReceiptUploadItem, 'offer'> {
  offer: ReceiptUploadOfferV2 | null;
}
export interface ReceiptUploadV2 extends Omit<
  ReceiptUploadV1,
  'version' | 'items'
> {
  version: typeof RECEIPT_UPLOAD_V2.version;
  items: ReceiptUploadItemV2[];
}
export interface SignedReceiptUploadV2 {
  upload: ReceiptUploadV2;
  signature: string;
}
