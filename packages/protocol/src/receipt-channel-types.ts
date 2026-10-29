// Bounded receipt RPC shapes; no inference input or storage policy belongs on this channel.
import type {
  RECEIPT_CHANNEL,
  RECEIPT_CHANNEL_METHODS,
  ReceiptChannelCode,
} from './constants';
import type { BuyerReceiptV1, ReceiptV1, SignedReceipt } from './receipt-types';

export type ConfirmedReceipt = ReceiptV1 & {
  buyer: SignedReceipt<BuyerReceiptV1>;
};
export interface ReceiptLookup {
  executionRequestId: string;
  requestDigest: string;
}
export type ReceiptChannelRequest = {
  version: typeof RECEIPT_CHANNEL.version;
  requestId: string;
} & (
  | { method: typeof RECEIPT_CHANNEL_METHODS.GET; params: ReceiptLookup }
  | {
      method: typeof RECEIPT_CHANNEL_METHODS.CONFIRM;
      params: { receipt: ConfirmedReceipt };
    }
);
export type ReceiptChannelResponse = {
  version: typeof RECEIPT_CHANNEL.version;
  requestId: string;
} & (
  | { result: { receipt: ReceiptV1 }; error?: never }
  | { error: { code: ReceiptChannelCode }; result?: never }
);
