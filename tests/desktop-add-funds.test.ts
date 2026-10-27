// Validates the local top-up form; no payment, transfer or balance mutation is possible.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { prepareTopUp, TOP_UP_STATUS } from '@gyblos/desktop/add-funds';
import { WALLET_STATUS } from '@gyblos/desktop/wallet';

const wallet = {
  status: WALLET_STATUS.READY,
  address: '11111111111111111111111111111111',
  backupVerified: true,
  fundingEnabled: false,
} as const;

void test('desktop top-up rejects amounts that are not positive currency values', () => {
  for (const amount of ['', '0', '-1', 'no', 'Infinity', '1e3', '0.001'])
    assert.equal(prepareTopUp(amount, wallet), TOP_UP_STATUS.INVALID_AMOUNT);
});
void test('desktop top-up requires the wallet to be ready', () => {
  assert.equal(
    prepareTopUp('10', { ...wallet, status: WALLET_STATUS.UNAVAILABLE }),
    TOP_UP_STATUS.WALLET_UNAVAILABLE,
  );
});
void test('desktop top-up requires a verified backup before any payment step', () => {
  assert.equal(
    prepareTopUp('10', { ...wallet, backupVerified: false }),
    TOP_UP_STATUS.BACKUP_REQUIRED,
  );
});
void test('desktop top-up never claims payment success or adds balance without a payment service', () => {
  const original = { ...wallet };
  for (const amount of ['10', '25', '50', '10.50'])
    assert.equal(
      prepareTopUp(amount, wallet),
      TOP_UP_STATUS.PAYMENT_UNAVAILABLE,
    );
  assert.deepEqual(wallet, original);
  assert.equal(wallet.fundingEnabled, false);
});
