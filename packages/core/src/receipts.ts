// Constructs local free receipt attestations; no transport, runtime wiring or collection.
import type { Signer } from '@gyblos/protocol/signing';
import type { BuyerReceiptV1, ReceiptV1, SellerReceiptV1 } from '@gyblos/protocol/receipt';
export type FreeSellerReceiptInput = Omit<SellerReceiptV1, 'version' | 'pricing' | 'amountAtomic' | 'feeAtomic'>;
export type ReceiptExecutionContext = Pick<SellerReceiptV1, 'requestId' | 'requestDigest' | 'sellerNodeId' | 'buyerNodeId' | 'owner' | 'selection' | 'reasoning' | 'streaming'>;
export interface FreeBuyerReceiptInput { seller: ReceiptV1['seller']; context: ReceiptExecutionContext; observed: BuyerReceiptV1['observed']; }
export function buildFreeSellerReceipt(_value: unknown): SellerReceiptV1 { throw new Error('Not implemented'); }
export async function createFreeSellerReceipt(_value: unknown, _signer: Signer): Promise<ReceiptV1> { throw new Error('Not implemented'); }
export async function buildFreeBuyerReceipt(_value: unknown): Promise<BuyerReceiptV1> { throw new Error('Not implemented'); }
export async function createFreeBuyerReceipt(_value: unknown, _signer: Signer): Promise<ReceiptV1> { throw new Error('Not implemented'); }
export function receiptTextSizes(_input: string, _output: string): SellerReceiptV1['sizes'] { throw new Error('Not implemented'); }
