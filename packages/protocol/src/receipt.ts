// Owns receipt signing and verification; never collects telemetry or resolves identity.
import { controlFail } from './control-validation';
import type { BuyerReceiptV1, ReceiptV1, SellerReceiptV1, SignedReceipt } from './receipt-types';
import type { Signer } from './signing';
export type * from './receipt-types';
export function parseSellerReceipt(_value: unknown): SellerReceiptV1 { return controlFail(); }
export function parseBuyerReceipt(_value: unknown): BuyerReceiptV1 { return controlFail(); }
export async function sellerReceiptDigest(_record: SellerReceiptV1): Promise<string> { return controlFail(); }
export async function signSellerReceipt(_record: SellerReceiptV1, _signer: Signer): Promise<SignedReceipt<SellerReceiptV1>> { return controlFail(); }
export async function signBuyerReceipt(_record: BuyerReceiptV1, _signer: Signer): Promise<SignedReceipt<BuyerReceiptV1>> { return controlFail(); }
export async function verifyReceipt(_value: unknown): Promise<ReceiptV1> { return controlFail(); }
