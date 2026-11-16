// `gyblos seller status` shows recent paid requests from the seller's payment ledger: settled requests
// and what they charged over the last day, what is still settling, and nothing when the seller never
// served a paid request. Read-only and offline; amounts are gross (before the Gyblos fee).
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import test from 'node:test';

import { UPTO_CHANNEL_STATES, type UptoChannelRecord } from 'x402-upto-metered';

import { paymentPathsIn } from '@gyblos/config';
import { summarizeUptoLedger } from '@gyblos/payments-upto';

import { atomicUsdc } from '../apps/node/src/status';
import { record } from './support/payment-upto-file';
import {
  daemonReady,
  HOUR,
  installUnit,
  NOW,
  status,
  system,
  withHome,
} from './support/status-fixture';

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

function ledgerText(rows: [UptoChannelRecord, number][]) {
  const channels: Record<
    string,
    { record: UptoChannelRecord; updatedAt: number }
  > = {};
  for (const [row, ageMs] of rows)
    channels[row.channelId] = { record: row, updatedAt: NOW - ageMs };
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
  [settled(channel(1), '1500'), HOUR],
  [settled(channel(2), '2500'), 2 * HOUR],
  [settled(channel(3), '9999'), 30 * HOUR],
  [record(channel(4), UPTO_CHANNEL_STATES.FAILED), HOUR],
  [record(channel(5), UPTO_CHANNEL_STATES.LAPSED), 40 * HOUR],
  [record(channel(6), UPTO_CHANNEL_STATES.ADMITTED), 50 * HOUR],
  [
    {
      ...record(channel(7), UPTO_CHANNEL_STATES.SETTLING),
      chargedAtomic: '700',
    },
    0,
  ],
];

void test('the ledger summary counts the last day of settled and failed requests and every pending one', () => {
  const summary = summarizeUptoLedger(ledgerText(ROWS), NOW - 24 * HOUR);
  assert.deepEqual(summary, {
    settled: 2,
    chargedAtomic: 4000n,
    pending: 2,
    failed: 1,
    lastSettledAt: NOW - HOUR,
  });
});

void test('USDC amounts print without trailing zeros', () => {
  assert.equal(atomicUsdc(0n), '0');
  assert.equal(atomicUsdc(1500n), '0.0015');
  assert.equal(atomicUsdc(1_000_000n), '1');
  assert.equal(atomicUsdc(1_234_567n), '1.234567');
});

async function writeLedger(homeRoot: string, text: string) {
  const path = paymentPathsIn({ GYBLOS_HOME: homeRoot }, 'seller').state;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, text, { mode: 0o600 });
}

void test('seller status prints recent paid requests from the payment ledger', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await installUnit(home);
    await writeLedger(home.home, ledgerText(ROWS));
    const result = await status(home, system(home));
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /^Paid requests, from the payment ledger:$/m);
    assert.match(
      result.stdout,
      /last 24h\s+2 settled, 0\.004 USDC charged \(before the Gyblos fee\); 1 not charged$/m,
    );
    assert.match(result.stdout, /settling now\s+2$/m);
    assert.match(
      result.stdout,
      new RegExp(
        `last settled\\s+${new Date(NOW - HOUR).toISOString().replace(/\.\d+Z$/, 'Z')}$`,
        'm',
      ),
    );
  }));

void test('seller status shows no paid section for a seller that never served a paid request', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await installUnit(home);
    const result = await status(home, system(home));
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.stdout, /Paid requests/);
  }));

void test('seller status reports an invalid payment ledger without echoing it', () =>
  withHome(async (home) => {
    await daemonReady(home);
    await installUnit(home);
    await writeLedger(home.home, '{"version":1,"secret-looking":"x"}');
    const result = await status(home, system(home));
    assert.match(result.stdout, /ledger\s+unavailable/);
    assert.doesNotMatch(result.output, /secret-looking/);
  }));
