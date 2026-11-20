// Seller status reports recent gross ledger charges and pending requests, read-only and offline.
// Unsafe paths and invalid dates never become sales; a missing ledger creates no paid section.
import assert from 'node:assert/strict';
import test from 'node:test';

import { UPTO_CHANNEL_STATES, type UptoChannelRecord } from 'x402-upto-metered';

import { summarizeUptoLedger } from '@gyblos/payments-upto';

import { record } from './support/payment-upto-file';
import { HOUR, NOW } from './support/status-fixture';

const DAY = 24 * HOUR;

function settled(id: string, charged: string): UptoChannelRecord {
  return {
    ...record(id, UPTO_CHANNEL_STATES.SETTLED),
    chargedAtomic: charged,
    settlement: {
      channelId: id,
      chargedAtomic: charged,
      refundedAtomic: String(1_030_000 - Number(charged)),
      transaction: `Tx${id}`,
    },
  };
}

// Rows with their absolute updatedAt.
function ledgerText(rows: [UptoChannelRecord, number][]) {
  const channels: Record<
    string,
    { record: UptoChannelRecord; updatedAt: number }
  > = {};
  for (const [row, updatedAt] of rows)
    channels[row.channelId] = { record: row, updatedAt };
  return JSON.stringify({
    version: 1,
    channels,
    deposits: {},
    claims: {},
    pending: {},
  });
}

const channel = (index: number) => String(index).padStart(64, 'a');

const ROWS: [UptoChannelRecord, number][] = [
  [settled(channel(1), '1500'), NOW - HOUR],
  [settled(channel(2), '2500'), NOW - 2 * HOUR],
  [settled(channel(3), '9999'), NOW - 30 * HOUR],
  [record(channel(4), UPTO_CHANNEL_STATES.FAILED), NOW - HOUR],
  [record(channel(5), UPTO_CHANNEL_STATES.LAPSED), NOW - 40 * HOUR],
  [record(channel(6), UPTO_CHANNEL_STATES.ADMITTED), NOW - 50 * HOUR],
  [
    {
      ...record(channel(7), UPTO_CHANNEL_STATES.SETTLING),
      chargedAtomic: '700',
    },
    NOW,
  ],
];

void test('the ledger summary counts the last day of settled and failed requests and every pending one', () => {
  assert.deepEqual(summarizeUptoLedger(ledgerText(ROWS), NOW - DAY, NOW), {
    settled: 2,
    chargedAtomic: 4000n,
    pending: 2,
    failed: 1,
    lastSettledAt: NOW - HOUR,
  });
});

void test('future and unsafe dates are not sales while explicit zero settlements count', () => {
  assert.deepEqual(
    summarizeUptoLedger(
      ledgerText([
        [settled(channel(1), '1500'), NOW + HOUR],
        [settled(channel(2), '2500'), Number.MAX_SAFE_INTEGER],
        [
          record(channel(5), UPTO_CHANNEL_STATES.ADMITTED),
          Number.MAX_SAFE_INTEGER,
        ],
        [settled(channel(6), '0'), NOW - HOUR],
      ]),
      NOW - DAY,
      NOW,
    ),
    // An explicit zero settlement counts; the pending channel counts whatever its date.
    {
      settled: 1,
      chargedAtomic: 0n,
      pending: 1,
      failed: 0,
      lastSettledAt: NOW - HOUR,
    },
  );
});
