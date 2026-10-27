// Tests the narrow public-address clipboard capability without OS clipboard or keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { copyPublicWalletAddress, WALLET_STATUS } from '@gyblos/desktop/wallet';

const address = '11111111111111111111111111111111';
const ready = {
  status: WALLET_STATUS.READY,
  address,
  backupVerified: false,
  fundingEnabled: false,
} as const;

void test('desktop wallet copy writes only its matching public address', () => {
  const writes: string[] = [];
  assert.equal(
    copyPublicWalletAddress(ready, [address], (text) => writes.push(text)),
    true,
  );
  assert.deepEqual(writes, [address]);
});

void test('desktop wallet copy rejects stale or arbitrary text and malformed arguments', () => {
  const writes: string[] = [];
  for (const args of [
    [],
    [address, address],
    ['arbitrary text'],
    [null],
    [{}],
  ]) {
    assert.equal(
      copyPublicWalletAddress(ready, args, (text) => writes.push(text)),
      false,
    );
  }
  assert.deepEqual(writes, []);
});

void test('desktop wallet copy rejects unavailable or missing public address', () => {
  const writes: string[] = [];
  for (const current of [
    { ...ready, status: WALLET_STATUS.UNAVAILABLE },
    { ...ready, address: null },
  ]) {
    assert.equal(
      copyPublicWalletAddress(current, [address], (text) => writes.push(text)),
      false,
    );
  }
  assert.deepEqual(writes, []);
});

void test('desktop wallet copy reports write failures without exposing platform details', () => {
  assert.equal(
    copyPublicWalletAddress(ready, [address], () => {
      throw new Error('Synthetic platform detail');
    }),
    false,
  );
});
