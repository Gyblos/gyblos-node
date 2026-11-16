// Owns the paid receipt version and signing domains; v1 and its transport remain separate.
import { RECEIPT } from '../constants';

export const RECEIPT_V2 = {
  version: 2,
  sellerDomain: 'gyblos/receipt-seller/v2\n',
  buyerDomain: 'gyblos/receipt-buyer/v2\n',
  sellerRecordBytes: RECEIPT.sellerRecordBytes,
  buyerRecordBytes: RECEIPT.buyerRecordBytes,
} as const;
