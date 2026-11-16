// Paid receipt/v2 contract; signatures attest usage and channel claims, not chain settlement.
import { controlFail } from './control-validation';
import type { SignedReceipt } from './receipt-types';
import type {
  BuyerReceiptV2,
  ReceiptV2,
  SellerReceiptV2,
} from './receipt-v2-types';
import type { Signer } from './signing';

export type * from './receipt-v2-types';
export { RECEIPT_V2 } from './receipt-v2/constants';

export function parseSellerReceiptV2(_value: unknown): SellerReceiptV2 {
  return controlFail();
}
export function parseBuyerReceiptV2(_value: unknown): BuyerReceiptV2 {
  return controlFail();
}
export async function sellerReceiptDigestV2(
  _value: SellerReceiptV2,
): Promise<string> {
  return controlFail();
}
export async function signSellerReceiptV2(
  _value: SellerReceiptV2,
  _signer: Signer,
): Promise<SignedReceipt<SellerReceiptV2>> {
  return controlFail();
}
export async function signBuyerReceiptV2(
  _value: BuyerReceiptV2,
  _signer: Signer,
): Promise<SignedReceipt<BuyerReceiptV2>> {
  return controlFail();
}
export async function verifyReceiptV2(_value: unknown): Promise<ReceiptV2> {
  return controlFail();
}
