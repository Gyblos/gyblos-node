// Exercises explicit wallet access with disposable homes and synthetic OS protection.
// No native keystore, existing profile, wallet funding or remote service is used.
import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BACKUP_ACTION,
  BACKUP_RESULT,
  createWalletService,
  prepareWalletProfile,
  WALLET,
  WALLET_PROVIDER,
  WALLET_STATUS,
} from '@gyblos/desktop/wallet';
import { createWalletHandlers } from '@gyblos/desktop/wallet-handlers';
import { createDesktopWalletSession } from '@gyblos/desktop/wallet-session';
import {
  parseWalletCollection,
  unavailableCollection,
  WALLET_SETTINGS_ACTION,
  WALLET_SETTINGS_RESULT,
} from '@gyblos/desktop/wallet-settings-model';

import {
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture';

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-wallet-on-demand-'));
  context.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, 'wallet');
  const protection = disposableProtection();
  const calls = { explain: 0, available: 0, encrypt: 0, decrypt: 0, files: 0 };
  const available = protection.available;
  const encrypt = protection.encrypt;
  const decrypt = protection.decrypt;
  protection.available = async () => {
    calls.available++;
    return available();
  };
  protection.encrypt = async (value) => {
    calls.encrypt++;
    return encrypt(value);
  };
  protection.decrypt = async (value) => {
    calls.decrypt++;
    return decrypt(value);
  };
  const controller = new AbortController();
  const approval = { run: async () => true };
  const open = () =>
    createDesktopWalletSession(
      root,
      protection,
      {
        approve: async () => {
          calls.files++;
          return false;
        },
        save: async () => {
          calls.files++;
          return null;
        },
        select: async () => {
          calls.files++;
          return null;
        },
      },
      controller.signal,
      async () => {
        calls.explain++;
        return approval.run();
      },
    );
  return { home, root, protection, calls, controller, approval, open };
}

for (const provider of Object.values(WALLET_PROVIDER)) {
  void test(`opening, polling and unused shutdown never consult ${provider} or initialize custody`, async (context) => {
    const f = await fixture(context);
    f.protection.provider = provider;
    const session = f.open();
    const collections = await Promise.all(
      Array.from({ length: 8 }, () => session.collection()),
    );
    assert.ok(
      collections.every(
        (value) => value.wallet.status === WALLET_STATUS.LOCKED,
      ),
    );
    assert.equal((await session.summary()).address, null);
    await session.settled();
    assert.deepEqual(f.calls, {
      explain: 0,
      available: 0,
      encrypt: 0,
      decrypt: 0,
      files: 0,
    });
    await assert.rejects(access(f.root), { code: 'ENOENT' });
  });
}

void test('declining the explanation leaves the wallet locked and never opens secure storage', async (context) => {
  const f = await fixture(context);
  f.approval.run = async () => false;
  const session = f.open();
  assert.equal((await session.activate()).wallet.status, WALLET_STATUS.LOCKED);
  assert.deepEqual(f.calls, {
    explain: 1,
    available: 0,
    encrypt: 0,
    decrypt: 0,
    files: 0,
  });
  await assert.rejects(access(f.root), { code: 'ENOENT' });
});

void test('the explanation completes before any OS access and concurrent activation shares one preparation', async (context) => {
  const f = await fixture(context);
  let approve: (value: boolean) => void = () => {};
  f.approval.run = () =>
    new Promise((resolve) => {
      approve = resolve;
    });
  const session = f.open();
  const attempts = [session.activate(), session.activate(), session.activate()];
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.explain, 1);
    assert.equal(f.calls.available, 0);
    assert.equal(f.calls.encrypt, 0);
  } finally {
    approve(true);
  }
  const views = await Promise.all(attempts);
  assert.ok(views.every((view) => view.wallet.status === WALLET_STATUS.READY));
  assert.equal(new Set(views.map((view) => view.wallet.address)).size, 1);
  assert.equal(f.calls.encrypt, 1);
  const snapshot = { ...f.calls };
  await Promise.all([
    session.summary(),
    session.collection(),
    session.activate(),
  ]);
  assert.deepEqual(
    f.calls,
    snapshot,
    'passive reads and an already unlocked activation must use the cache',
  );
});

void test('backup, selection and copy cannot activate a locked wallet indirectly', async (context) => {
  const f = await fixture(context);
  const session = f.open();
  assert.equal(
    await session.run({
      action: WALLET_SETTINGS_ACTION.SELECT,
      address: '11111111111111111111111111111111',
    }),
    WALLET_SETTINGS_RESULT.UNAVAILABLE,
  );
  assert.equal(
    await session.backup({
      action: BACKUP_ACTION.CREATE,
      address: '11111111111111111111111111111111',
      password: TEST_BACKUP_PASSWORD,
    }),
    BACKUP_RESULT.FAILED,
  );
  assert.equal(
    await session.copy(['11111111111111111111111111111111'], () =>
      assert.fail('must not copy'),
    ),
    false,
  );
  assert.deepEqual(f.calls, {
    explain: 0,
    available: 0,
    encrypt: 0,
    decrypt: 0,
    files: 0,
  });
});

void test('an existing encrypted identity stays untouched until approved and is reused on activation', async (context) => {
  const f = await fixture(context);
  const existing = await createWalletService(f.root, f.protection).summary();
  const path = join(f.root, WALLET.DIRECTORY, WALLET.RECORD);
  const bytes = await readFile(path);
  Object.assign(f.calls, {
    explain: 0,
    available: 0,
    encrypt: 0,
    decrypt: 0,
    files: 0,
  });
  const session = f.open();
  assert.equal(
    (await session.collection()).wallet.status,
    WALLET_STATUS.LOCKED,
  );
  assert.equal(f.calls.decrypt, 0);
  const unlocked = await session.activate();
  assert.equal(unlocked.wallet.address, existing.address);
  assert.equal(unlocked.wallet.backupVerified, false);
  assert.equal(unlocked.wallet.fundingEnabled, false);
  assert.equal(f.calls.encrypt, 0);
  assert.deepEqual(await readFile(path), bytes);
});

void test('interrupted custody remains recoverable and is never replaced by on-demand activation', async (context) => {
  const f = await fixture(context);
  const directory = join(f.root, WALLET.DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = join(directory, WALLET.STAGING);
  await writeFile(marker, 'synthetic-interrupted-marker');
  const session = f.open();
  assert.equal(
    (await session.activate()).wallet.status,
    WALLET_STATUS.RECOVERY_REQUIRED,
  );
  assert.equal(f.calls.encrypt, 0);
  assert.equal(await readFile(marker, 'utf8'), 'synthetic-interrupted-marker');
  await assert.rejects(access(join(directory, WALLET.RECORD)), {
    code: 'ENOENT',
  });
});

void test('shutdown during the explanation drains it without later OS access or a ready result', async (context) => {
  const f = await fixture(context);
  let approve: (value: boolean) => void = () => {};
  f.approval.run = () =>
    new Promise((resolve) => {
      approve = resolve;
    });
  const session = f.open();
  const activating = session.activate();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.calls.explain, 1);
    f.controller.abort();
  } finally {
    approve(true);
  }
  await session.settled();
  assert.equal((await activating).wallet.status, WALLET_STATUS.UNAVAILABLE);
  assert.equal(f.calls.available, 0);
  await assert.rejects(access(f.root), { code: 'ENOENT' });
});

void test('missing secure storage is retried only by a new explicit approval', async (context) => {
  const f = await fixture(context);
  let enabled = false;
  f.protection.available = async () => {
    f.calls.available++;
    return enabled;
  };
  const session = f.open();
  assert.equal(
    (await session.activate()).wallet.status,
    WALLET_STATUS.UNAVAILABLE,
  );
  const snapshot = { ...f.calls };
  await Promise.all(Array.from({ length: 8 }, () => session.collection()));
  assert.deepEqual(f.calls, snapshot);
  enabled = true;
  assert.equal((await session.activate()).wallet.status, WALLET_STATUS.READY);
  assert.equal(f.calls.explain, 2);
  assert.equal(f.calls.encrypt, 1);
});

void test('profile creation is automatic and a locked collection cannot claim verified funds or identities', async (context) => {
  const f = await fixture(context);
  const profile = join(f.home, 'app-profile');
  prepareWalletProfile(profile);
  await access(profile);
  const locked = unavailableCollection(WALLET_STATUS.LOCKED);
  assert.deepEqual(parseWalletCollection(locked), locked);
  assert.equal(
    parseWalletCollection({
      wallet: { ...locked.wallet, backupVerified: true },
      wallets: [],
    }).wallet.status,
    WALLET_STATUS.UNAVAILABLE,
  );
  assert.deepEqual(f.calls, {
    explain: 0,
    available: 0,
    encrypt: 0,
    decrypt: 0,
    files: 0,
  });
});

void test('activation IPC accepts only the current main frame, no arguments, and suppresses late navigation results', async () => {
  const contents = {};
  const frame = {};
  let current = frame;
  let closed = false;
  let calls = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = unavailableCollection(WALLET_STATUS.LOCKED);
  const session = {
    summary: async () => locked.wallet,
    collection: async () => locked,
    run: async () => WALLET_SETTINGS_RESULT.FAILED,
    backup: async () => BACKUP_RESULT.FAILED,
    copy: async () => false,
    activate: async () => {
      calls++;
      await pending;
      return locked;
    },
  };
  const window = {
    contents,
    mainFrame: () => current,
    destroyed: () => closed,
  };
  const handlers = createWalletHandlers(session, window, () => {});
  const event = { sender: contents, senderFrame: frame };
  await handlers.activate({ ...event, sender: {} }, []);
  await handlers.activate({ ...event, senderFrame: {} }, []);
  await handlers.activate(event, [{}]);
  closed = true;
  await handlers.activate(event, []);
  closed = false;
  await createWalletHandlers(null, window, () => {}).activate(event, []);
  assert.equal(calls, 0);
  const result = handlers.activate(event, []);
  assert.equal(calls, 1);
  current = {};
  release();
  assert.equal((await result).wallet.status, WALLET_STATUS.UNAVAILABLE);
});
