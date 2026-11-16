// Seller status reports recent gross ledger charges and pending requests, read-only and offline.
// Unsafe paths and invalid dates never become sales; a missing ledger creates no paid section.
import assert from 'node:assert/strict';
import { chmod, mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { UPTO_CHANNEL_STATES, type UptoChannelRecord } from 'x402-upto-metered';

import { paymentPathsIn } from '@gyblos/config';
import { summarizeUptoLedger } from '@gyblos/payments-upto';
import { P2P_ROLES } from '@gyblos/protocol/constants';

import { record } from './support/payment-upto-file';
import {
  daemonReady,
  HOUR,
  installUnit,
  NOW,
  status,
  system,
  withHome,
  type Home,
} from './support/status-fixture';

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

function ledgerPaths(home: Home) {
  return paymentPathsIn({ GYBLOS_HOME: home.home }, P2P_ROLES.SELLER);
}

async function writeLedger(home: Home, text: string, mode = 0o700) {
  const path = ledgerPaths(home).state;
  await mkdir(dirname(path), { recursive: true, mode });
  await chmod(dirname(path), mode);
  await writeFile(path, text, { mode: 0o600 });
}

async function sellerStatus(home: Home) {
  await daemonReady(home);
  await installUnit(home);
  return status(home, system(home));
}

void test('seller status prints recent paid requests from the payment ledger', () =>
  withHome(async (home) => {
    await writeLedger(home, ledgerText(ROWS));
    const result = await sellerStatus(home);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /^Paid requests, from the payment ledger:$/m);
    assert.match(
      result.stdout,
      /last 24h\s+2 settled, 0\.004 USDC charged \(gross, including the Gyblos fee\); 1 not charged$/m,
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

void test('seller status prints whole and fractional USDC without trailing zeros', () =>
  withHome(async (home) => {
    await writeLedger(
      home,
      ledgerText([
        [settled(channel(1), '1000000'), NOW - HOUR],
        [settled(channel(2), '234567'), NOW - HOUR],
      ]),
    );
    const result = await sellerStatus(home);
    assert.match(result.stdout, /2 settled, 1\.234567 USDC charged/);
  }));

void test('seller status survives future and unsafe ledger dates', () =>
  withHome(async (home) => {
    await writeLedger(
      home,
      ledgerText([
        [settled(channel(1), '1500'), NOW + HOUR],
        [settled(channel(2), '2500'), Number.MAX_SAFE_INTEGER],
      ]),
    );
    const result = await sellerStatus(home);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /last 24h\s+0 settled, 0 USDC charged/);
    assert.match(result.stdout, /last settled\s+none$/m);
  }));

void test('seller status shows no paid section for a seller that never served a paid request', () =>
  withHome(async (home) => {
    const result = await sellerStatus(home);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(result.stdout, /Paid requests/);
  }));

void test('seller status reports an invalid payment ledger without echoing it', () =>
  withHome(async (home) => {
    await writeLedger(home, '{"version":1,"secret-looking":"x"}');
    const result = await sellerStatus(home);
    assert.match(result.stdout, /ledger\s+unavailable/);
    assert.doesNotMatch(result.output, /secret-looking/);
  }));

void test('seller status refuses a payment directory others can read', () =>
  withHome(async (home) => {
    await writeLedger(home, ledgerText(ROWS), 0o755);
    const result = await sellerStatus(home);
    assert.match(result.stdout, /ledger\s+unavailable/);
    assert.doesNotMatch(result.stdout, /settled/);
  }));

void test('seller status refuses a payment directory that is a link', () =>
  withHome(async (home) => {
    await writeLedger(home, ledgerText(ROWS));
    const { directory } = ledgerPaths(home);
    const elsewhere = join(home.root, 'elsewhere');
    await rename(directory, elsewhere);
    await symlink(elsewhere, directory);
    const result = await sellerStatus(home);
    assert.match(result.stdout, /ledger\s+unavailable/);
    assert.doesNotMatch(result.stdout, /settled/);
  }));
