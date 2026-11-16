// Defines paid node attestations with an explicit channel and cumulative authorization interval.
import type { OFFER_PRICING_KINDS } from './constants';
import type {
  BuyerReceiptV1,
  SellerReceiptV1,
  SignedReceipt,
} from './receipt-types';
import type { RECEIPT_V2 } from './receipt-v2/constants';

export interface ReceiptPaymentChannel {
  channelId: string;
  payer: string;
  baseAtomic: string;
  cumulativeAtomic: string;
  protocolFeeBps: number;
}
export interface SellerReceiptV2 extends Omit<
  SellerReceiptV1,
  'version' | 'pricing'
> {
  version: typeof RECEIPT_V2.version;
  pricing: Extract<
    SellerReceiptV1['pricing'],
    { kind: typeof OFFER_PRICING_KINDS.PAID }
  >;
  channel: ReceiptPaymentChannel;
}
export interface BuyerReceiptV2 extends Omit<BuyerReceiptV1, 'version'> {
  version: typeof RECEIPT_V2.version;
}
export interface ReceiptV2 {
  seller: SignedReceipt<SellerReceiptV2>;
  buyer?: SignedReceipt<BuyerReceiptV2>;
}
