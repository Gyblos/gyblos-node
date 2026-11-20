import assert from 'node:assert/strict';

import type { P2PRole } from '@gyblos/protocol/constants';
import { controlObject } from '@gyblos/protocol/control-validation';
import type { SellerReceiptV1 } from '@gyblos/protocol/receipt';

type ReceiptBinding = Pick<
  SellerReceiptV1,
  'requestId' | 'buyerNodeId' | 'sellerNodeId' | 'selection' | 'streaming'
>;
export function assertReceiptTelemetry(
  value: unknown,
  expected: ReceiptBinding,
  role: P2PRole,
) {
  const event = telemetryMetadata(value);
  assert.equal(event.role, role);
  assert.equal(event.requestId, expected.requestId);
  assert.equal(event.buyerNodeId, expected.buyerNodeId);
  assert.equal(event.sellerNodeId, expected.sellerNodeId);
  assert.deepEqual(event.selection, expected.selection);
  assert.equal(event.streaming, expected.streaming);
  return event;
}

function telemetryMetadata(value: unknown) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const allowed = [
    'type',
    'at',
    'role',
    'buyerNodeId',
    'sellerNodeId',
    'selection',
    'engineKind',
    'streaming',
    'meteringMode',
    'requestId',
    'usage',
    'sizes',
    'totalMs',
    'finishReason',
    'code',
    'reason',
    'delivered',
    'refusal',
    'firstTokenMs',
    'amountAtomic',
    'feeAtomic',
    'network',
    'asset',
    'receipt',
    'path',
    'generationMs',
  ];
  const keys = Object.keys(value);
  assert.ok(keys.every((key) => allowed.includes(key)));
  return controlObject(value, keys);
}
