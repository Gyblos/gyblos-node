// Owns the output rate `gyblos seller status` derives from signed receipts: completed sales with output
// only, time after the first token when streamed and the whole request otherwise, and none without data.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { StoredReceipt } from '@gyblos/node/receipts';
import {
  FREE_EXECUTION_CODES,
  RECEIPT_OUTCOMES,
} from '@gyblos/protocol/constants';
import type { SellerReceiptV1 } from '@gyblos/protocol/receipt';

import { outputRate, receiptActivity } from '../apps/node/src/status';
import { sellerRecord } from './support/receipt-fixture';

const NOW = 1_800_000_000_000;

function stored(record: Partial<SellerReceiptV1>): StoredReceipt {
  return {
    receipt: {
      seller: { record: { ...sellerRecord(), ...record } },
    },
  } as unknown as StoredReceipt;
}

const timing = (firstTokenMs: number | null, totalMs: number) => ({
  timing: { receivedAt: NOW - 1000, firstTokenMs, totalMs },
});
const usage = (outputTokens: number) => ({
  usage: { inputTokens: 7, outputTokens, reasoningTokens: null },
});

void test('status rate: streamed sales count the time after the first token, others the whole request', () => {
  const activity = receiptActivity(
    [
      stored({ ...timing(100, 1100), ...usage(50) }),
      stored({ ...timing(null, 1000), ...usage(30), streaming: false }),
    ],
    NOW,
  );
  assert.equal(activity.day.rateTokens, 80);
  assert.equal(activity.day.rateMs, 2000);
  assert.equal(outputRate(activity.day), 40);
});

void test('status rate: failed, cancelled and empty sales do not count; no sale gives no rate', () => {
  const activity = receiptActivity(
    [
      stored({
        ...timing(10, 500),
        ...usage(9),
        outcome: RECEIPT_OUTCOMES.FAILED,
        code: FREE_EXECUTION_CODES.TIMEOUT,
        finishReason: null,
      }),
      stored({
        ...timing(10, 500),
        ...usage(9),
        outcome: RECEIPT_OUTCOMES.CANCELLED,
        code: FREE_EXECUTION_CODES.CANCELLED,
        finishReason: null,
      }),
      stored({ ...timing(10, 500), ...usage(0) }),
      stored({ ...timing(500, 500), ...usage(4) }),
    ],
    NOW,
  );
  assert.equal(activity.day.rateTokens, 0);
  assert.equal(outputRate(activity.day), undefined);
  assert.equal(outputRate(receiptActivity([], NOW).week), undefined);
});
