// Exercises equivalent PKCS8 encodings through saved-file verification with disposable keys.
// Provider labels use injected encryption; no native keystore, existing wallet or funding.
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BACKUP_ACTION,
  BACKUP_RESULT,
  createBackupFlow,
  createWalletService,
  WALLET,
  WALLET_PROVIDER,
} from '@gyblos/desktop/wallet';
import { createBackupCodec } from '@gyblos/desktop/wallet-backup';

import {
  disposableIdentity,
  disposableProtection,
  TEST_BACKUP_PASSWORD,
} from './support/portable-backup-fixture.js';

function equivalentPkcs8(secret: string) {
  const original = Buffer.from(secret, 'base64');
  const alternate = Buffer.concat([original, Buffer.from([0xa0, 0x00])]);
  try {
    // RFC5208 permits optional attributes. The fixed Node Ed25519 fixture uses
    // a short-form sequence length; an empty attributes set changes no key bits.
    assert.equal(original[0], 0x30);
    assert.ok(original[1]! < 0x80);
    assert.equal(original[1], original.length - 2);
    alternate[1] = original[1]! + 2;
    const publicKey = (key: Buffer) =>
      createPublicKey(
        createPrivateKey({ key, format: 'der', type: 'pkcs8' }),
      ).export({ format: 'der', type: 'spki' });
    assert.deepEqual(publicKey(alternate), publicKey(original));
    const encoded = alternate.toString('base64');
    assert.notEqual(encoded, secret);
    return encoded;
  } finally {
    original.fill(0);
    alternate.fill(0);
  }
}

for (const provider of Object.values(WALLET_PROVIDER)) {
  void test(`equivalent PKCS8 saved backup retains the same address and verification with injected ${provider}`, async (context) => {
    const home = await mkdtemp(join(tmpdir(), 'gyblos-pkcs8-verification-'));
    context.after(() => rm(home, { recursive: true, force: true }));
    const root = join(home, 'wallet');
    const protection = disposableProtection();
    protection.provider = provider;
    const wallet = createWalletService(root, protection);
    const initial = await wallet.summary();
    const recordPath = join(root, WALLET.DIRECTORY, WALLET.RECORD);
    const installedRecord = await readFile(recordPath);
    const alternate = await wallet.withSecret(async (secret) =>
      equivalentPkcs8(secret),
    );
    const codec = createBackupCodec();
    const file = join(home, 'selected-backup.json');
    const flow = createBackupFlow(
      wallet,
      {
        approve: async () => true,
        save: async () => file,
        select: async () => file,
      },
      new AbortController().signal,
    );
    const request = {
      action: BACKUP_ACTION.VERIFY,
      password: TEST_BACKUP_PASSWORD,
    };

    // The address comparison must still reject another identity before any mark.
    const other = disposableIdentity();
    assert.notEqual(other.address, initial.address);
    await writeFile(
      file,
      await codec.seal(other.secret, TEST_BACKUP_PASSWORD),
      { mode: 0o600 },
    );
    assert.equal(await flow.run(request), BACKUP_RESULT.FAILED);
    assert.equal((await wallet.summary()).backupVerified, false);
    assert.equal((await wallet.summary()).fundingEnabled, false);

    const bytes = await codec.seal(alternate, TEST_BACKUP_PASSWORD);
    try {
      assert.equal(
        await codec.open(bytes, TEST_BACKUP_PASSWORD, initial.address!),
        alternate,
      );
      await writeFile(file, bytes);
    } finally {
      bytes.fill(0);
    }
    assert.equal(await flow.run(request), BACKUP_RESULT.VERIFIED);
    assert.deepEqual(await readFile(recordPath), installedRecord);
    const restarted = await createWalletService(root, protection).summary();
    assert.equal(restarted.address, initial.address);
    assert.equal(restarted.backupVerified, true);
    assert.equal(restarted.fundingEnabled, false);
  });
}
