// Startup readiness uses public-only states, without Electron, keys or real networking.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NETWORK_STATE, startupPending } from '@gyblos/desktop/startup-state';
import { parseWalletSummary, WALLET_STATUS } from '@gyblos/desktop/wallet';

function state(status: (typeof WALLET_STATUS)[keyof typeof WALLET_STATUS]) {
  return parseWalletSummary({
    status,
    address:
      status === WALLET_STATUS.READY
        ? '11111111111111111111111111111111'
        : null,
    fundingEnabled: false,
    backupVerified: false,
  });
}

void test('desktop startup waits for wallet preparation or the preview network', () => {
  assert.equal(
    startupPending(state(WALLET_STATUS.LOADING), NETWORK_STATE.CONNECTED),
    true,
  );
  assert.equal(
    startupPending(state(WALLET_STATUS.UNAVAILABLE), NETWORK_STATE.CONNECTING),
    true,
  );
});
void test('desktop startup permits preview after a storage error without enabling funding', () => {
  const wallet = state(WALLET_STATUS.RECOVERY_REQUIRED);
  assert.equal(startupPending(wallet, NETWORK_STATE.CONNECTED), false);
  assert.equal(startupPending(wallet, NETWORK_STATE.PAUSED), false);
  assert.equal(wallet.fundingEnabled, false);
  assert.equal(wallet.backupVerified, false);
});

void test('desktop startup completes when protected storage and the simulation are ready', () => {
  assert.equal(
    startupPending(state(WALLET_STATUS.READY), NETWORK_STATE.CONNECTED),
    false,
  );
});
