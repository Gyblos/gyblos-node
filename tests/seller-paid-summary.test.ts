// Paid status refuses incomplete charge evidence and invalid reporting windows.
// Reading an active seller's synthetic ledger must not acquire its lock or change files.
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';

import { UPTO_CHANNEL_STATES, type UptoChannelRecord } from 'x402-upto-metered';

import {
  readUptoLedgerSummary,
  summarizeUptoLedger,
} from '@gyblos/payments-upto';

import {
  ledger,
  paths,
  record,
  unavailable,
} from './support/payment-upto-file';
import {
  daemonReady,
  HOUR,
  installUnit,
  NOW,
  status,
  system,
  withHome,
} from './support/status-fixture';

function settled(): UptoChannelRecord {
  return {
    ...record('SyntheticChannel', UPTO_CHANNEL_STATES.SETTLED),
    chargedAtomic: '4000',
    settlement: {
      channelId: 'SyntheticChannel',
      chargedAtomic: '4000',
      refundedAtomic: '1026000',
      transaction: 'SyntheticTransaction',
    },
  };
}

function text(row: UptoChannelRecord, updatedAt = NOW) {
  return JSON.stringify({
    version: 1,
    channels: { [row.channelId]: { record: row, updatedAt } },
    deposits: {},
    claims: {},
    pending: {},
  });
}

void test('a recent settled record without a settlement amount makes paid status unavailable', () => {
  for (const row of [
    record('SyntheticChannel', UPTO_CHANNEL_STATES.SETTLED),
    {
      ...record('SyntheticChannel', UPTO_CHANNEL_STATES.SETTLED),
      chargedAtomic: '0',
    },
  ]) {
    assert.throws(
      () => summarizeUptoLedger(text(row), NOW - HOUR, NOW),
      unavailable,
    );
  }
});

void test('conflicting recorded and settled charges make paid status unavailable', () => {
  assert.throws(
    () =>
      summarizeUptoLedger(
        text({ ...settled(), chargedAtomic: '4001' }),
        NOW - HOUR,
        NOW,
      ),
    unavailable,
  );
});

void test('paid reporting windows must be ordered, finite and representable dates', () => {
  for (const [since, now] of [
    [Number.NaN, NOW],
    [NOW - HOUR, Number.POSITIVE_INFINITY],
    [NOW, NOW - HOUR],
    [NOW - HOUR, Number.MAX_SAFE_INTEGER],
    [-Number.MAX_SAFE_INTEGER, NOW],
  ]) {
    assert.throws(
      () => summarizeUptoLedger(text(settled()), since, now),
      unavailable,
    );
  }
});

void test('paid reporting includes both window boundaries and excludes future settlements', () => {
  for (const updatedAt of [NOW - HOUR, NOW]) {
    assert.equal(
      summarizeUptoLedger(text(settled(), updatedAt), NOW - HOUR, NOW).settled,
      1,
    );
  }
  assert.equal(
    summarizeUptoLedger(text(settled(), NOW + 1), NOW - HOUR, NOW).settled,
    0,
  );
});

void test('an absent seller payment directory is not created by a summary read', () =>
  withHome(async (home) => {
    const before = await readdir(home.home, { recursive: true });
    assert.equal(
      await readUptoLedgerSummary(paths(home.home), NOW - HOUR, NOW),
      undefined,
    );
    assert.deepEqual(await readdir(home.home, { recursive: true }), before);
  }));

void test('a live seller ledger is read without acquiring its lock or changing its files', () =>
  withHome(async (home) => {
    const writer = await ledger(home.home);
    try {
      await writer.channels.put(settled());
      const location = paths(home.home);
      const entries = await readdir(location.directory);
      const before = await Promise.all(
        [location.state, location.lock].map(async (path) => ({
          data: await readFile(path),
          stat: await stat(path),
        })),
      );
      for (let index = 0; index < 2; index++) {
        const summary = await readUptoLedgerSummary(location, NOW - HOUR, NOW);
        assert.equal(summary?.settled, 1);
        assert.equal(summary.chargedAtomic, 4000n);
      }
      assert.deepEqual(await readdir(location.directory), entries);
      const after = await Promise.all(
        [location.state, location.lock].map(async (path) => ({
          data: await readFile(path),
          stat: await stat(path),
        })),
      );
      for (let index = 0; index < before.length; index++) {
        assert.deepEqual(after[index].data, before[index].data);
        assert.equal(after[index].stat.mtimeMs, before[index].stat.mtimeMs);
        assert.equal(after[index].stat.ino, before[index].stat.ino);
      }
      await writer.channels.put(record('NextSyntheticChannel'));
    } finally {
      await writer.close();
    }
  }));

void test('the public status command does not turn incomplete settlement evidence into zero sales', () =>
  withHome(async (home) => {
    const writer = await ledger(home.home);
    try {
      await writer.channels.put(
        record('SyntheticChannel', UPTO_CHANNEL_STATES.SETTLED),
      );
      await daemonReady(home);
      await installUnit(home);
      const result = await status(home, system(home));
      assert.equal(result.code, 0, result.output);
      assert.match(result.stdout, /ledger\s+unavailable/);
      assert.doesNotMatch(
        result.stdout,
        /0 settled|SyntheticChannel|SyntheticTransaction/,
      );
    } finally {
      await writer.close();
    }
  }));
