// Validates the renderer boundary without Electron, keys or filesystem access.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKUP_ACTION,
  BACKUP_RESULT,
  WALLET_STATUS,
} from '@gyblos/desktop/wallet';
import { createWalletHandlers } from '@gyblos/desktop/wallet-handlers';
import {
  parseActiveBackupRequest,
  parseWalletCollection,
  parseWalletSettingsRequest,
  WALLET_SETTINGS_ACTION,
  WALLET_SETTINGS_RESULT,
} from '@gyblos/desktop/wallet-settings-model';

const address = '11111111111111111111111111111111';
const wallet = {
  status: WALLET_STATUS.READY,
  address,
  backupVerified: false,
  fundingEnabled: false,
} as const;
void test('Settings requests reject extras, unsafe addresses and unbounded credentials', () => {
  assert.equal(
    parseWalletSettingsRequest({
      action: WALLET_SETTINGS_ACTION.SELECT,
      address: '../secret',
    }),
    null,
  );
  assert.equal(
    parseWalletSettingsRequest({
      action: WALLET_SETTINGS_ACTION.SELECT,
      address,
      path: 'private',
    }),
    null,
  );
  assert.equal(
    parseWalletSettingsRequest({
      action: WALLET_SETTINGS_ACTION.RESTORE,
      password: 'x'.repeat(2000),
    }),
    null,
  );
  assert.equal(
    parseActiveBackupRequest({
      action: BACKUP_ACTION.CREATE,
      password: 'synthetic-password',
    }),
    null,
  );
  assert.ok(
    parseActiveBackupRequest({
      address,
      action: BACKUP_ACTION.CREATE,
      password: 'synthetic-password',
    }),
  );
});
void test('collection parsing refuses funding flags, secret fields, duplicate identities and a missing active wallet', () => {
  const valid = { wallet, wallets: [wallet] };
  assert.deepEqual(parseWalletCollection(valid), valid);
  for (const value of [
    { wallet: { ...wallet, fundingEnabled: true }, wallets: [wallet] },
    { wallet, wallets: [{ ...wallet, secret: 'private' }] },
    { wallet, wallets: [wallet, wallet] },
    { wallet, wallets: [] },
    { ...valid, path: 'private' },
  ]) {
    assert.equal(
      parseWalletCollection(value).wallet.status,
      WALLET_STATUS.UNAVAILABLE,
    );
  }
});
void test('every wallet handler refuses foreign frames, destroyed windows, wrong arity and smoke sessions', async () => {
  const contents = {};
  const frame = {};
  const event = { sender: contents, senderFrame: frame };
  let calls = 0;
  let closed = false;
  const session = {
    summary: async () => {
      calls++;
      return wallet;
    },
    collection: async () => {
      calls++;
      return { wallet, wallets: [wallet] };
    },
    run: async () => {
      calls++;
      return WALLET_SETTINGS_RESULT.SELECTED;
    },
    backup: async () => {
      calls++;
      return BACKUP_RESULT.FAILED;
    },
    copy: async () => {
      calls++;
      return true;
    },
  };
  const handlers = createWalletHandlers(
    session,
    { contents, mainFrame: () => frame, destroyed: () => closed },
    () => {},
  );
  await handlers.summary({ sender: {}, senderFrame: frame }, []);
  await handlers.collection({ sender: contents, senderFrame: {} }, []);
  await handlers.manage(event, []);
  await handlers.backup(event, [{}, {}]);
  await handlers.copy(event, []);
  closed = true;
  await handlers.manage(event, [{}]);
  assert.equal(calls, 0);
  const smoke = createWalletHandlers(
    null,
    { contents, mainFrame: () => frame, destroyed: () => false },
    () => {},
  );
  assert.equal(
    (await smoke.summary(event, [])).status,
    WALLET_STATUS.UNAVAILABLE,
  );
  assert.equal(await smoke.manage(event, [{}]), WALLET_SETTINGS_RESULT.FAILED);
});
