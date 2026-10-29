// Validates bounded receipt snapshots and their role identity; unknown file contents never pass through.
import type { HomeRole } from '@gyblos/config';
import { canonicalJson } from '@gyblos/protocol';
import { CONTROL_LIMITS, P2P_ROLES } from '@gyblos/protocol/constants';
import {
  controlArray,
  controlHex,
  controlInteger,
  controlObject,
} from '@gyblos/protocol/control-validation';
import { verifyReceipt, type ReceiptV1 } from '@gyblos/protocol/receipt';
import type { ReceiptStoreKey } from '@gyblos/transport-iroh/receipt-service';

import { RECEIPT_STORAGE } from './constants';
import { receiptSignal, receiptUnavailable } from './receipt-file';

export interface StoredReceipt {
  storedAt: number;
  receipt: ReceiptV1;
}
export function receiptKey(value: ReceiptV1) {
  const record = value.seller.record;
  return canonicalJson({
    executionRequestId: record.requestId,
    requestDigest: record.requestDigest,
    buyerNodeId: record.buyerNodeId,
    sellerNodeId: record.sellerNodeId,
  });
}
export function lookupKey(value: unknown) {
  const input = controlObject(value, [
    'executionRequestId',
    'requestDigest',
    'buyerNodeId',
    'sellerNodeId',
  ]);
  const key: ReceiptStoreKey = {
    executionRequestId: controlHex(
      input.executionRequestId,
      CONTROL_LIMITS.requestIdBytes,
    ),
    requestDigest: controlHex(input.requestDigest),
    buyerNodeId: controlHex(input.buyerNodeId),
    sellerNodeId: controlHex(input.sellerNodeId),
  };
  return canonicalJson(key);
}
export function assertReceiptRole(
  receipt: ReceiptV1,
  role: HomeRole,
  nodeId: string,
) {
  const record = receipt.seller.record;
  if (
    (role === P2P_ROLES.SELLER ? record.sellerNodeId : record.buyerNodeId) !==
    nodeId
  )
    receiptUnavailable();
}
export async function parseReceiptSnapshot(
  text: string | undefined,
  role: HomeRole,
  nodeId: string,
  now: number,
  signal?: AbortSignal,
): Promise<StoredReceipt[]> {
  if (text === undefined) return [];
  const value: unknown = JSON.parse(text);
  if (canonicalJson(value) + '\n' !== text) receiptUnavailable();
  const input = controlObject(value, [
    'schemaVersion',
    'role',
    'nodeId',
    'entries',
  ]);
  if (
    input.schemaVersion !== RECEIPT_STORAGE.schemaVersion ||
    input.role !== role ||
    input.nodeId !== nodeId
  )
    receiptUnavailable();
  const records = controlArray(input.entries, RECEIPT_STORAGE.maxEntries);
  const entries: StoredReceipt[] = [];
  const keys = new Set<string>();
  for (const item of records) {
    receiptSignal(signal);
    const entry = controlObject(item, ['storedAt', 'receipt']);
    const storedAt = controlInteger(entry.storedAt, 0, now);
    const receipt = await verifyReceipt(entry.receipt);
    assertReceiptRole(receipt, role, nodeId);
    const key = receiptKey(receipt);
    if (keys.has(key)) receiptUnavailable();
    keys.add(key);
    entries.push({ storedAt, receipt });
  }
  receiptSignal(signal);
  return entries;
}
