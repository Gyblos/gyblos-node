// Adds strict paid channel invariants while delegating unchanged observation parsing to receipt/v1.
import { canonicalJson } from './canonical';
import {
  CONTROL_CODES,
  OFFER_PRICING_KINDS,
  PAYMENT_BINDING,
  RECEIPT,
} from './constants';
import {
  controlAddress,
  controlAtomic,
  controlFail,
  controlInteger,
  controlObject,
} from './control-validation';
import { settlementShares } from './payment-binding';
import { parseBuyerReceipt, parseSellerReceipt } from './receipt-parser';
import type {
  BuyerReceiptV2,
  ReceiptPaymentChannel,
  SellerReceiptV2,
} from './receipt-v2-types';
import { RECEIPT_V2 } from './receipt-v2/constants';

function versionedRecord(value: unknown) {
  if (!value || typeof value !== 'object') return controlFail();
  // Validate descriptors before reading values. The v1 parser rejects every common-field extra;
  // only the seller's explicitly extracted channel extension is removed before that validation.
  const input = controlObject(value, Object.keys(value));
  if (input.version !== RECEIPT_V2.version)
    return controlFail(CONTROL_CODES.VERSION);
  return input;
}
function boundedRecord(value: unknown, maximum: number) {
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > maximum)
    return controlFail(CONTROL_CODES.LIMIT);
}
function paymentChannel(value: unknown): ReceiptPaymentChannel {
  const input = controlObject(value, [
    'channelId',
    'payer',
    'baseAtomic',
    'cumulativeAtomic',
    'protocolFeeBps',
  ]);
  return {
    channelId: controlAddress(input.channelId),
    payer: controlAddress(input.payer),
    baseAtomic: controlAtomic(input.baseAtomic),
    cumulativeAtomic: controlAtomic(input.cumulativeAtomic),
    protocolFeeBps: controlInteger(
      input.protocolFeeBps,
      0,
      PAYMENT_BINDING.maxFeeBps,
    ),
  };
}
function channelAmounts(record: SellerReceiptV2) {
  const { channel } = record;
  const difference =
    BigInt(channel.cumulativeAtomic) - BigInt(channel.baseAtomic);
  if (difference < 0n || difference !== BigInt(record.amountAtomic))
    return controlFail(CONTROL_CODES.POLICY);
  const before = settlementShares(channel.baseAtomic, channel.protocolFeeBps);
  const after = settlementShares(
    channel.cumulativeAtomic,
    channel.protocolFeeBps,
  );
  if (
    BigInt(after.feeAtomic) - BigInt(before.feeAtomic) !==
    BigInt(record.feeAtomic)
  )
    return controlFail(CONTROL_CODES.POLICY);
}
export function parseSellerReceiptV2(value: unknown): SellerReceiptV2 {
  const { channel, ...common } = versionedRecord(value);
  const base = parseSellerReceipt({ ...common, version: RECEIPT.version });
  const pricing = base.pricing;
  if (
    pricing.kind !== OFFER_PRICING_KINDS.PAID ||
    (pricing.prices.inputAtomicPerMtok === '0' &&
      pricing.prices.outputAtomicPerMtok === '0')
  )
    return controlFail(CONTROL_CODES.POLICY);
  const record: SellerReceiptV2 = {
    ...base,
    version: RECEIPT_V2.version,
    pricing,
    channel: paymentChannel(channel),
  };
  channelAmounts(record);
  boundedRecord(record, RECEIPT_V2.sellerRecordBytes);
  return record;
}
export function parseBuyerReceiptV2(value: unknown): BuyerReceiptV2 {
  const base = parseBuyerReceipt({
    ...versionedRecord(value),
    version: RECEIPT.version,
  });
  const record: BuyerReceiptV2 = { ...base, version: RECEIPT_V2.version };
  boundedRecord(record, RECEIPT_V2.buyerRecordBytes);
  return record;
}
