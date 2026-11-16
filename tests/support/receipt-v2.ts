// Synthetic channel identifiers and ephemeral node signers for the additive paid receipt contract.
import { getBase58Decoder } from '@solana/kit';

import { OFFER_PRICING_KINDS, RECEIPT } from '@gyblos/protocol/constants';
import {
  RECEIPT_V2,
  type BuyerReceiptV2,
  type SellerReceiptV2,
} from '@gyblos/protocol/receipt-v2';

import { buyerRecord, receiptSigner, sellerRecord } from './receipt-fixture';

export const receiptAddress = (byte: number) =>
  getBase58Decoder().decode(new Uint8Array(32).fill(byte));
export function paidRecord(
  sellerNodeId?: string,
  buyerNodeId?: string,
): SellerReceiptV2 {
  return {
    ...sellerRecord(sellerNodeId, buyerNodeId),
    version: RECEIPT_V2.version,
    pricing: {
      kind: OFFER_PRICING_KINDS.PAID,
      prices: { inputAtomicPerMtok: '7000000', outputAtomicPerMtok: '7000000' },
      network: 'solana:synthetic',
      asset: receiptAddress(3),
    },
    amountAtomic: '70',
    feeAtomic: '2',
    usage: { inputTokens: 2, outputTokens: 8, reasoningTokens: null },
    channel: {
      channelId: receiptAddress(4),
      payer: receiptAddress(5),
      baseAtomic: '0',
      cumulativeAtomic: '70',
      protocolFeeBps: 400,
    },
  };
}
export function paidBuyerRecord(
  record: SellerReceiptV2,
  digest: string,
): BuyerReceiptV2 {
  return {
    ...buyerRecord({ ...record, version: RECEIPT.version }, digest),
    version: RECEIPT_V2.version,
    observed: {
      inputTokens: record.usage.inputTokens,
      outputTokens: record.usage.outputTokens,
      outputBytes: record.sizes.outputBytes,
      firstTokenMs: record.timing.firstTokenMs,
      totalMs: record.timing.totalMs,
    },
  };
}
export function paidReceiptFixture() {
  const seller = receiptSigner();
  const buyer = receiptSigner();
  return { seller, buyer, record: paidRecord(seller.nodeId, buyer.nodeId) };
}
