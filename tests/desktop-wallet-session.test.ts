// Product startup and Settings use this coordinator, with synthetic dialogs/stores.
// All homes and identities are disposable; no real keystore, key or provider access.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { desktopWalletLibraryPaths } from '@gyblos/config/home';
import { BACKUP_ACTION, BACKUP_RESULT, createWalletService, WALLET, WALLET_PROVIDER, WALLET_STATUS } from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';
import { createDesktopWalletSession } from '@gyblos/desktop/wallet-session';
import { WALLET_SETTINGS_ACTION, WALLET_SETTINGS_RESULT } from '@gyblos/desktop/wallet-settings-model';

import { disposableIdentity, disposableProtection, TEST_BACKUP_PASSWORD } from './support/portable-backup-fixture.js';

async function fixture(context: { after(fn: () => Promise<void>): void }) {
 const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-session-'));
 context.after(() => rm(home, {recursive: true, force: true}));
 const root = join(home, 'wallet');
 const protection = disposableProtection();
 const controller = new AbortController();
 const imported = disposableIdentity();
 const path = join(home, 'restore.json');
 await writeFile(path, await createBackupCodec().seal(imported.secret, TEST_BACKUP_PASSWORD));
 const saved = join(home, 'saved.json');
 const dialogs = { approve: async () => true, save: async () => saved, select: async () => path };
 const open = () => createDesktopWalletSession(root, protection, dialogs, controller.signal);
 return {home,root,protection,controller,imported,path,saved,dialogs,open};
}
for (const provider of Object.values(WALLET_PROVIDER)) {
 void test(`startup automatically prepares once; Settings restore/select/backup survives reopen with injected ${provider}`, async context => {
  const f = await fixture(context); f.protection.provider = provider;
  const session = f.open();
  const first = await session.ready;
  assert.equal(first.wallet.status, WALLET_STATUS.READY);
  assert.ok(first.wallet.address);
  const original = await readFile(join(f.root, WALLET.DIRECTORY, WALLET.RECORD));
  assert.equal(await session.run({action: WALLET_SETTINGS_ACTION.RESTORE, password: TEST_BACKUP_PASSWORD}), WALLET_SETTINGS_RESULT.RESTORED);
  let view = await session.collection();
  assert.equal(view.wallet.address, first.wallet.address);
  assert.equal(view.wallets.length, 2);
  assert.equal(await session.run({action: WALLET_SETTINGS_ACTION.SELECT, address: f.imported.address}), WALLET_SETTINGS_RESULT.SELECTED);
  f.dialogs.select = async () => f.saved;
  assert.equal(await session.backup({address: f.imported.address, action: BACKUP_ACTION.CREATE, password: TEST_BACKUP_PASSWORD}), BACKUP_RESULT.SAVED);
  assert.equal(await session.backup({address: f.imported.address, action: BACKUP_ACTION.VERIFY, password: TEST_BACKUP_PASSWORD}), BACKUP_RESULT.VERIFIED);
  view = await f.open().ready;
  assert.equal(view.wallet.address, f.imported.address);
  assert.equal(view.wallet.backupVerified, true);
  assert.equal(view.wallets.find(wallet => wallet.address === first.wallet.address)?.backupVerified, false);
  assert.ok(view.wallets.every(wallet => wallet.fundingEnabled === false));
  assert.deepEqual(await readFile(join(f.root, WALLET.DIRECTORY, WALLET.RECORD)), original);
 });
}
void test('duplicate and wrong-password restoration preserve both wallets and selection', async context => {
 const f=await fixture(context); const session=f.open(); const initial=await session.ready;
 assert.equal(await session.run({action:WALLET_SETTINGS_ACTION.RESTORE,password:'wrong password'}),WALLET_SETTINGS_RESULT.FAILED);
 assert.equal((await session.collection()).wallet.address,initial.wallet.address);
 assert.equal(await session.run({action:WALLET_SETTINGS_ACTION.RESTORE,password:TEST_BACKUP_PASSWORD}),WALLET_SETTINGS_RESULT.RESTORED);
 assert.equal(await session.run({action:WALLET_SETTINGS_ACTION.RESTORE,password:TEST_BACKUP_PASSWORD}),WALLET_SETTINGS_RESULT.EXISTS);
 assert.equal((await session.collection()).wallets.length,2);
});
void test('closing during automatic encryption waits for settlement and does not publish a ready UI', async context => {
 const f=await fixture(context);
 let release:()=>void=()=>{}; let entered:()=>void=()=>{};
 const blocked=new Promise<void>(resolve=>{release=resolve;}); const reached=new Promise<void>(resolve=>{entered=resolve;});
 const encrypt=f.protection.encrypt;
 f.protection.encrypt=async text=>{entered();await blocked;return encrypt(text);};
 const session=f.open(); await reached; f.controller.abort();
 let done=false; const settling=session.settled().then(()=>{done=true;}); await Promise.resolve(); assert.equal(done,false);
 release(); await settling;
 assert.equal((await session.ready).wallet.status,WALLET_STATUS.UNAVAILABLE);
 assert.equal((await createWalletService(f.root,f.protection).summary()).status,WALLET_STATUS.READY);
});
void test('an already aborted startup does not create a root or consult encryption', async context=>{
 const f=await fixture(context); f.controller.abort(); let availability=0;
 f.protection.available=async()=>{availability++;return true;};
 const session=f.open(); assert.equal((await session.ready).wallet.status,WALLET_STATUS.UNAVAILABLE);
 assert.equal(availability,0); await assert.rejects(readFile(join(f.root,WALLET.DIRECTORY,WALLET.RECORD)),{code:'ENOENT'});
});
void test('existing incomplete library never initializes a replacement original wallet',async context=>{
 const f=await fixture(context); await mkdir(f.root,{mode:0o700}); await mkdir(desktopWalletLibraryPaths(f.root).directory,{mode:0o700});
 const session=f.open(); assert.equal((await session.ready).wallet.status,WALLET_STATUS.RECOVERY_REQUIRED);
 await assert.rejects(readFile(join(f.root,WALLET.DIRECTORY,WALLET.RECORD)),{code:'ENOENT'});
});
void test('blocked secure storage opens the app without creating an unprotected wallet',async context=>{
 const f=await fixture(context); f.protection.available=async()=>false;
 const session=f.open(); assert.equal((await session.ready).wallet.status,WALLET_STATUS.UNAVAILABLE);
 assert.equal(await session.run({action:WALLET_SETTINGS_ACTION.RESTORE,password:TEST_BACKUP_PASSWORD}),WALLET_SETTINGS_RESULT.UNAVAILABLE);
 await assert.rejects(readFile(join(f.root,WALLET.DIRECTORY,WALLET.RECORD)),{code:'ENOENT'});
});
void test('operations are mutually exclusive and closing a native dialog retains original custody',async context=>{
 const f=await fixture(context); const session=f.open(); const before=await session.ready;
 let entered:()=>void=()=>{}; let release:(path:string|null)=>void=()=>{};
 const reached=new Promise<void>(resolve=>{entered=resolve;}); const selected=new Promise<string|null>(resolve=>{release=resolve;});
 f.dialogs.select=()=>{entered();return selected;};
 const restoring=session.run({action:WALLET_SETTINGS_ACTION.RESTORE,password:TEST_BACKUP_PASSWORD}); await reached;
 assert.equal(await session.run({action:WALLET_SETTINGS_ACTION.SELECT,address:before.wallet.address}),WALLET_SETTINGS_RESULT.BUSY);
 assert.equal(await session.backup({address:before.wallet.address,action:BACKUP_ACTION.CREATE,password:TEST_BACKUP_PASSWORD}),BACKUP_RESULT.BUSY);
 f.controller.abort(); let done=false; const settling=session.settled().then(()=>{done=true;}); await Promise.resolve(); assert.equal(done,false);
 release(f.path); assert.equal(await restoring,WALLET_SETTINGS_RESULT.CANCELLED); await settling;
 assert.equal((await createWalletService(f.root,f.protection).summary()).address,before.wallet.address);
});
