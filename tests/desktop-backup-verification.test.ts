// Uses disposable wallets, encrypted backups and injected OS protection only.
// Verification is remembered per identity; it must never authorize funding.
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BACKUP_ACTION, BACKUP_RESULT, createBackupFlow, createWalletService, WALLET, WALLET_PROVIDER, parseWalletSummary } from '@gyblos/desktop/wallet';

import { disposableProtection, TEST_BACKUP_PASSWORD } from './support/portable-backup-fixture.js';

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-verification-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'wallet');
  const protection = disposableProtection();
  const wallet = createWalletService(root, protection);
  const initial = await wallet.summary();
  const file = join(home, 'backup.json');
  const controller = new AbortController();
  const flow = createBackupFlow(wallet, { approve: async () => true, save: async () => file, select: async () => file }, controller.signal);
  async function run(action: typeof BACKUP_ACTION[keyof typeof BACKUP_ACTION], password = TEST_BACKUP_PASSWORD) {
    return flow.run({ action, password });
  }
  return { home, root, protection, wallet, file, initial, run, controller };
}

for (const provider of Object.values(WALLET_PROVIDER)) {
  void test(`backup verification survives restart with injected ${provider} protection and no funding`, async (context) => {
    const f = await fixture(context);
    f.protection.provider = provider;
    // The provider must be chosen before creating its local record.
    const root = join(f.home, provider);
    const wallet = createWalletService(root, f.protection);
    const before = await wallet.summary();
    const file = join(f.home, `${provider}.json`);
    const flow = createBackupFlow(wallet, { approve: async () => true, save: async () => file, select: async () => file }, f.controller.signal);
    assert.equal(await flow.run({ action: BACKUP_ACTION.CREATE, password: TEST_BACKUP_PASSWORD }), BACKUP_RESULT.SAVED);
    assert.equal((await wallet.summary()).backupVerified, false);
    assert.equal(await flow.run({ action: BACKUP_ACTION.VERIFY, password: TEST_BACKUP_PASSWORD }), BACKUP_RESULT.VERIFIED);
    const restarted = await createWalletService(root, f.protection).summary();
    assert.equal(restarted.address, before.address);
    assert.equal(restarted.backupVerified, true);
    assert.equal(restarted.fundingEnabled, false);
    assert.deepEqual(parseWalletSummary(restarted), restarted);
    const receipt = await readFile(join(root, WALLET.DIRECTORY, 'backup-verified.enc'));
    assert.equal(receipt.includes(Buffer.from(TEST_BACKUP_PASSWORD)), false);
    assert.equal(receipt.includes(Buffer.from(file)), false);
    assert.equal(receipt.includes(Buffer.from(before.address!)), false);
  });
}

void test('wrong password and cancelled verification do not remember a backup', async (context) => {
  const f = await fixture(context);
  assert.equal(await f.run(BACKUP_ACTION.CREATE), BACKUP_RESULT.SAVED);
  assert.equal(await f.run(BACKUP_ACTION.VERIFY, 'incorrect password'), BACKUP_RESULT.FAILED);
  assert.equal((await f.wallet.summary()).backupVerified, false);
  f.controller.abort();
  assert.equal(await f.run(BACKUP_ACTION.VERIFY), BACKUP_RESULT.CANCELLED);
  assert.equal((await createWalletService(f.root, f.protection).summary()).backupVerified, false);
});

void test('another identity cannot use a copied verification record', async (context) => {
  const f = await fixture(context);
  await f.run(BACKUP_ACTION.CREATE);
  await f.run(BACKUP_ACTION.VERIFY);
  const otherRoot = join(f.home, 'other');
  const other = createWalletService(otherRoot, f.protection);
  const otherSummary = await other.summary();
  await copyFile(join(f.root, WALLET.DIRECTORY, 'backup-verified.enc'), join(otherRoot, WALLET.DIRECTORY, 'backup-verified.enc'));
  assert.notEqual(otherSummary.address, f.initial.address);
  const reloaded = await createWalletService(otherRoot, f.protection).summary();
  assert.equal(reloaded.address, otherSummary.address);
  assert.equal(reloaded.backupVerified, false);
  assert.equal(reloaded.fundingEnabled, false);
});

void test('corrupted verification is ignored and a new successful check can replace it', async (context) => {
  const f = await fixture(context);
  await f.run(BACKUP_ACTION.CREATE);
  await f.run(BACKUP_ACTION.VERIFY);
  const receipt = join(f.root, WALLET.DIRECTORY, 'backup-verified.enc');
  await writeFile(receipt, 'corrupted', { mode: 0o600 });
  assert.equal((await f.wallet.summary()).backupVerified, false);
  assert.equal(await f.run(BACKUP_ACTION.VERIFY), BACKUP_RESULT.VERIFIED);
  assert.equal((await createWalletService(f.root, f.protection).summary()).backupVerified, true);
  if (process.platform !== 'win32') {
    await chmod(receipt, 0o644);
    assert.equal((await f.wallet.summary()).backupVerified, false);
  }
});
