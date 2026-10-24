// Proves identity persistence in disposable injected stores, not native OS acceptance.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createBackupCodec } from '@gyblos/desktop/wallet-backup';

import {
  disposableIdentity,
  disposableProtection,
  restoreDisposable,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture.js';

async function assertAbsent(path: string) {
  await assert.rejects(readFile(path));
}

void test('portable recovery absence check accepts a missing path and rejects existing directories and files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-portable-absence-'));
  try {
    await assertAbsent(join(home, 'missing'));
    await assert.rejects(assertAbsent(home));
    const file = join(home, 'existing');
    await writeFile(file, 'synthetic existing file');
    await assert.rejects(assertAbsent(file));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test('portable backup survives isolated destination persistence and fresh service reload', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-portable-'));
  try {
    const original = disposableIdentity();
    const backup = await createBackupCodec().seal(
      original.secret,
      TEST_BACKUP_PASSWORD,
    );
    await restoreDisposable(
      join(home, 'destination'),
      backup,
      original.address,
      disposableProtection(),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
void test('portable recovery harness refuses existing or interrupted destinations without replacing bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-portable-'));
  try {
    const original = disposableIdentity();
    const backup = await createBackupCodec().seal(
      original.secret,
      TEST_BACKUP_PASSWORD,
    );
    const destination = join(home, 'destination');
    await mkdir(destination);
    const marker = join(destination, 'unchanged');
    await writeFile(marker, 'existing synthetic marker');
    await assert.rejects(
      restoreDisposable(
        destination,
        backup,
        original.address,
        disposableProtection(),
      ),
    );
    assert.equal(await readFile(marker, 'utf8'), 'existing synthetic marker');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
void test('portable recovery harness never creates a destination after cancellation or unavailable protection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-portable-'));
  try {
    const original = disposableIdentity();
    const backup = await createBackupCodec().seal(
      original.secret,
      TEST_BACKUP_PASSWORD,
    );
    const controller = new AbortController();
    controller.abort();
    const destination = join(home, 'destination');
    await assert.rejects(
      restoreDisposable(
        destination,
        backup,
        original.address,
        disposableProtection(),
        controller.signal,
      ),
    );
    await assert.rejects(
      restoreDisposable(destination, backup, original.address, {
        ...disposableProtection(),
        available: async () => false,
      }),
    );
    await assertAbsent(destination);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
