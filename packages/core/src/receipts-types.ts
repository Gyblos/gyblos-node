// Defines content-free inputs to free receipt policy; callers own execution evidence and node signers.
import type {
  BuyerReceiptV1,
  ReceiptV1,
  SellerReceiptV1,
} from '@gyblos/protocol/receipt';

export type FreeSellerReceiptInput = Omit<
  SellerReceiptV1,
  'version' | 'pricing' | 'amountAtomic' | 'feeAtomic'
>;
export type ReceiptExecutionContext = Pick<
  SellerReceiptV1,
  | 'requestId'
  | 'requestDigest'
  | 'sellerNodeId'
  | 'buyerNodeId'
  | 'owner'
  | 'selection'
  | 'reasoning'
  | 'streaming'
>;
export interface FreeBuyerReceiptInput {
  seller: ReceiptV1['seller'];
  context: ReceiptExecutionContext;
  observed: BuyerReceiptV1['observed'];
}
