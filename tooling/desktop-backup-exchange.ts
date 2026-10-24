// CI-only exchange of encrypted disposable fixtures; never reads product homes.
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createWalletService } from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';
import { createWalletRestorer } from '@gyblos/desktop/wallet-restore';

import {
  disposableIdentity,
  disposableProtection,
  restoreDisposable,
  TEST_BACKUP_PASSWORD,
} from '../tests/support/portable-backup-fixture.js';

async function produce(directory: string) {
  await mkdir(directory, { recursive: true });
  const identity = disposableIdentity();
  const started = performance.now();
  const backup = await createBackupCodec().seal(
    identity.secret,
    TEST_BACKUP_PASSWORD,
  );
  await writeFile(join(directory, 'backup.json'), backup);
  await writeFile(
    join(directory, 'public.json'),
    JSON.stringify({ address: identity.address, source: process.platform }),
  );
  process.stdout.write(
    JSON.stringify({
      source: process.platform,
      encrypted: true,
      sealMs: Math.round(performance.now() - started),
    }) + '\n',
  );
}
async function restoreInternal(
  root: string,
  backup: Uint8Array,
  expectedAddress: string,
) {
  const protection = disposableProtection();
  const restored = await createWalletRestorer(root, protection).restore(
    backup,
    TEST_BACKUP_PASSWORD,
  );
  assert.equal(restored.address, expectedAddress);
  assert.equal(restored.backupVerified, false);
  assert.equal(restored.fundingEnabled, false);
  assert.deepEqual(
    await createWalletService(root, protection).summary(),
    restored,
  );
}
async function consume(directory: string) {
  const home = await mkdtemp(join(tmpdir(), 'gyblos-backup-exchange-'));
  try {
    const entries = await readdir(directory);
    const producerPlatforms = ['darwin', 'linux', 'win32'];
    assert.equal(
      entries.length,
      producerPlatforms.length,
      'All three producer artifacts are required',
    );
    const sources = new Set<string>();
    for (const entry of entries) {
      const publicData: unknown = JSON.parse(
        await readFile(join(directory, entry, 'public.json'), 'utf8'),
      );
      assert.ok(
        publicData &&
          typeof publicData === 'object' &&
          'address' in publicData &&
          typeof publicData.address === 'string' &&
          'source' in publicData &&
          typeof publicData.source === 'string',
      );
      sources.add(publicData.source);
      const backup = await readFile(join(directory, entry, 'backup.json'));
      const started = performance.now();
      await restoreDisposable(
        join(home, entry),
        backup,
        publicData.address,
        disposableProtection(),
      );
      await restoreInternal(
        join(home, `${entry}-internal`),
        backup,
        publicData.address,
      );
      process.stdout.write(
        JSON.stringify({
          internalRestore: true,
          source: publicData.source,
          destination: process.platform,
          sameAddress: true,
          fundingEnabled: false,
          openAndPersistMs: Math.round(performance.now() - started),
        }) + '\n',
      );
    }
    assert.deepEqual([...sources].sort(), producerPlatforms);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
async function main() {
  const [mode, directory] = process.argv.slice(2);
  if (!directory || (mode !== 'produce' && mode !== 'consume'))
    throw new Error(
      'Expected produce/consume and disposable fixture directory.',
    );
  if (mode === 'produce') await produce(directory);
  else await consume(directory);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
