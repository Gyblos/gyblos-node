// Detaches expected execution identity before asynchronous verification; no trust from seller assertions.
import { canonicalJson } from '@gyblos/protocol';
import { CONTROL_LIMITS } from '@gyblos/protocol/constants';
import { parseModelSelection } from '@gyblos/protocol/control-requests';
import {
  controlAddress,
  controlFail,
  controlHex,
  controlObject,
  controlReasoning,
} from '@gyblos/protocol/control-validation';

import type { ReceiptExecutionContext } from './receipts-types';

export function receiptContext(value: unknown): ReceiptExecutionContext {
  const input = controlObject(value, [
    'requestId',
    'requestDigest',
    'sellerNodeId',
    'buyerNodeId',
    'owner',
    'selection',
    'reasoning',
    'streaming',
  ]);
  if (typeof input.streaming !== 'boolean') return controlFail();
  return {
    requestId: controlHex(input.requestId, CONTROL_LIMITS.requestIdBytes),
    requestDigest: controlHex(input.requestDigest),
    sellerNodeId: controlHex(input.sellerNodeId),
    buyerNodeId: controlHex(input.buyerNodeId),
    owner: controlAddress(input.owner),
    selection: parseModelSelection(input.selection),
    reasoning: controlReasoning(input.reasoning),
    streaming: input.streaming,
  };
}
export function sameReceiptContext(
  expected: ReceiptExecutionContext,
  actual: ReceiptExecutionContext,
): boolean {
  return canonicalJson(expected) === canonicalJson(receiptContext(actual));
}
