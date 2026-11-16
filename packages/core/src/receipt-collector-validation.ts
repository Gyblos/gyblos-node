// Verifies bounded canonical receipt bytes and signed observations; no storage, identity registry or I/O.
import { canonicalJson } from '@gyblos/protocol';
import { CONTROL_CODES, OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import { verifyReceipt, type ReceiptV1 } from '@gyblos/protocol/receipt';

import { RECEIPT_COLLECTOR_CODES, RECEIPT_COLLECTOR_LIMITS } from './constants';
import {
  collectorFail,
  ReceiptCollectorError,
} from './receipt-collector-errors';
import type { PrivateFreeReceipt } from './receipt-collector-types';
import { observedDisputes, receiptKey, sha256Hex } from './receipt-evidence';

function checkDepth(value: unknown) {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (item.depth > RECEIPT_COLLECTOR_LIMITS.depth)
      collectorFail(RECEIPT_COLLECTOR_CODES.LIMIT);
    if (item.value && typeof item.value === 'object')
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
  }
}
function decodeReceipt(body: Uint8Array): unknown {
  if (!(body instanceof Uint8Array) || !body.byteLength)
    return collectorFail(RECEIPT_COLLECTOR_CODES.INVALID);
  if (body.byteLength > RECEIPT_COLLECTOR_LIMITS.bytes)
    return collectorFail(RECEIPT_COLLECTOR_CODES.LIMIT);
  // Decode synchronously before crypto yields, detaching input from the caller's mutable buffer.
  const text = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(body);
  const value: unknown = JSON.parse(text);
  checkDepth(value);
  if (canonicalJson(value) !== text)
    return collectorFail(RECEIPT_COLLECTOR_CODES.INVALID);
  return value;
}
function confirmObservations(receipt: ReceiptV1) {
  if (!receipt.buyer)
    return collectorFail(RECEIPT_COLLECTOR_CODES.PAIR_REQUIRED);
  const seller = receipt.seller.record;
  const buyer = receipt.buyer.record;
  if (
    canonicalJson(observedDisputes(seller, buyer.observed)) !==
    canonicalJson(buyer.disputed)
  )
    return collectorFail(RECEIPT_COLLECTOR_CODES.DISPUTE);
  return { seller: receipt.seller, buyer: receipt.buyer };
}
function validationError(error: unknown): never {
  if (error instanceof ReceiptCollectorError) throw error;
  if (error instanceof ControlError) {
    if (error.code === CONTROL_CODES.SIGNATURE)
      return collectorFail(RECEIPT_COLLECTOR_CODES.SIGNATURE);
    if (error.code === CONTROL_CODES.POLICY)
      return collectorFail(RECEIPT_COLLECTOR_CODES.BINDING);
    if (error.code === CONTROL_CODES.LIMIT)
      return collectorFail(RECEIPT_COLLECTOR_CODES.LIMIT);
  }
  return collectorFail(RECEIPT_COLLECTOR_CODES.INVALID);
}
export async function prepareCollectedReceipt(
  body: Uint8Array,
): Promise<PrivateFreeReceipt> {
  try {
    const receipt = await verifyReceipt(decodeReceipt(body));
    if (receipt.seller.record.pricing.kind !== OFFER_PRICING_KINDS.FREE)
      return collectorFail(RECEIPT_COLLECTOR_CODES.NOT_FREE);
    const confirmed = confirmObservations(receipt);
    const record = receipt.seller.record;
    const key = receiptKey(record);
    const fingerprint = await sha256Hex(canonicalJson(confirmed));
    return { key, fingerprint, receipt: confirmed };
  } catch (error) {
    return validationError(error);
  }
}
