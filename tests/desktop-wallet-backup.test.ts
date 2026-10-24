// Exercises only generated unfunded identities and the internal portable codec.
import assert from 'node:assert/strict';
import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  scrypt,
} from 'node:crypto';
import { test } from 'node:test';

import { getBase58Decoder } from '@solana/kit';

import { parseWalletSummary, WALLET_STATUS } from '@gyblos/desktop/wallet';
import {
  BACKUP,
  BACKUP_ERROR,
  BackupError,
  createBackupCodec,
} from '@gyblos/desktop/wallet-backup';

function identity() {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = createPublicKey(pair.privateKey).export({ format: 'jwk' });
  assert.ok(publicKey.x);
  return {
    secret: pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    address: getBase58Decoder().decode(Buffer.from(publicKey.x, 'base64url')),
  };
}
const password = 'Synthetic portable password 🔐';
const coded = (code: BackupError['code']) => (error: unknown) =>
  error instanceof BackupError && error.code === code;

void test('portable backup matches independent authenticated crypto and rejects authenticated non-wallet content', async () => {
  const original = identity();
  const codec = createBackupCodec();
  const record = JSON.parse(
    (await codec.seal(original.secret, password)).toString(),
  );
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(record.salt, 'base64'),
      32,
      { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
      (error, bytes) => (error ? reject(error) : resolve(bytes)),
    );
  });
  const aad = Buffer.from(
    JSON.stringify([
      'gyblos-wallet-backup',
      1,
      'scrypt-n131072-r8-p1',
      'aes-256-gcm',
      'pkcs8-ed25519',
      record.salt,
      record.nonce,
    ]),
  );
  const nonce = Buffer.from(record.nonce, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  assert.equal(
    Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('base64'),
    original.secret,
  );
  const cipher = createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(aad);
  const invalid = Buffer.concat([
    cipher.update('not an Ed25519 wallet'),
    cipher.final(),
  ]);
  const file = Buffer.from(
    JSON.stringify({
      ...record,
      ciphertext: invalid.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }),
  );
  await assert.rejects(
    codec.open(file, password, original.address),
    coded(BACKUP_ERROR.INVALID_INPUT),
  );
  key.fill(0);
});

void test('portable backup preserves the exact Ed25519 identity without enabling funding', async () => {
  const original = identity();
  const codec = createBackupCodec();
  const file = await codec.seal(original.secret, password);
  assert.equal(
    await codec.open(file, password, original.address),
    original.secret,
  );
  assert.equal(file.includes(Buffer.from(original.secret)), false);
  for (const flag of ['backupVerified', 'fundingEnabled']) {
    const summary = parseWalletSummary({
      status: WALLET_STATUS.READY,
      address: original.address,
      backupVerified: false,
      fundingEnabled: false,
      [flag]: true,
    });
    assert.equal(summary.fundingEnabled, false);
    assert.equal(summary.backupVerified, false);
  }
});
void test('portable backup randomizes salt and nonce and fixes supported algorithms', async () => {
  const original = identity();
  const codec = createBackupCodec();
  const left = JSON.parse(
    (await codec.seal(original.secret, password)).toString(),
  );
  const right = JSON.parse(
    (await codec.seal(original.secret, password)).toString(),
  );
  assert.equal(left.format, 'gyblos-wallet-backup');
  assert.equal(left.version, 1);
  assert.equal(left.kdf, 'scrypt-n131072-r8-p1');
  assert.equal(left.cipher, 'aes-256-gcm');
  assert.notEqual(left.salt, right.salt);
  assert.notEqual(left.nonce, right.nonce);
});
void test('portable backup rejects wrong password and every authenticated field alteration', async () => {
  const original = identity();
  const codec = createBackupCodec();
  const file = await codec.seal(original.secret, password);
  await assert.rejects(
    codec.open(file, password + 'wrong', original.address),
    coded(BACKUP_ERROR.AUTHENTICATION),
  );
  const record = JSON.parse(file.toString());
  for (const field of ['salt', 'nonce', 'ciphertext', 'tag']) {
    const bytes = Buffer.from(record[field], 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const changed = Buffer.from(
      JSON.stringify({ ...record, [field]: bytes.toString('base64') }),
    );
    await assert.rejects(
      codec.open(changed, password, original.address),
      coded(BACKUP_ERROR.AUTHENTICATION),
    );
  }
  for (const field of ['format', 'version', 'kdf', 'cipher', 'keyFormat']) {
    const changed = Buffer.from(
      JSON.stringify({ ...record, [field]: 'unsupported' }),
    );
    await assert.rejects(
      codec.open(changed, password, original.address),
      coded(BACKUP_ERROR.INVALID_FILE),
    );
  }
});
void test('portable backup rejects malformed and excessive inputs before expensive work', async () => {
  const original = identity();
  const codec = createBackupCodec();
  const valid = JSON.parse(
    (await codec.seal(original.secret, password)).toString(),
  );
  const invalid = [
    Buffer.alloc(0),
    Buffer.alloc(BACKUP.MAX_FILE_BYTES + 1),
    Buffer.from('{'),
    Buffer.from('null'),
    Buffer.from('[]'),
    Buffer.from(
      JSON.stringify(valid).replace('"version":1', '"version":1,"version":1'),
    ),
  ];
  for (const file of invalid)
    await assert.rejects(
      codec.open(file, password, original.address),
      coded(BACKUP_ERROR.INVALID_FILE),
    );
  for (const change of [
    { extra: true },
    { kdf: { N: Number.MAX_SAFE_INTEGER } },
    { salt: 'bad' },
    { nonce: '' },
    { tag: '' },
    { ciphertext: '***' },
  ]) {
    await assert.rejects(
      codec.open(
        Buffer.from(JSON.stringify({ ...valid, ...change })),
        password,
        original.address,
      ),
      coded(BACKUP_ERROR.INVALID_FILE),
    );
  }
  for (const text of ['', 'short', 'a'.repeat(BACKUP.MAX_PASSWORD_BYTES + 1)]) {
    await assert.rejects(
      codec.seal(original.secret, text),
      coded(BACKUP_ERROR.INVALID_INPUT),
    );
  }
  await assert.rejects(
    codec.seal('invalid key', password),
    coded(BACKUP_ERROR.INVALID_INPUT),
  );
});
void test('portable backup refuses a different expected address and keeps Unicode password bytes exact', async () => {
  const original = identity();
  const codec = createBackupCodec();
  const text = 'Test password e\u0301 🔐';
  const file = await codec.seal(original.secret, text);
  await assert.rejects(
    codec.open(file, text, identity().address),
    coded(BACKUP_ERROR.IDENTITY),
  );
  await assert.rejects(
    codec.open(file, text.normalize('NFC'), original.address),
    coded(BACKUP_ERROR.AUTHENTICATION),
  );
  assert.equal(await codec.open(file, text, original.address), original.secret);
});
void test('portable backup bounds concurrent KDF work and does not publish cancelled output', async () => {
  const original = identity();
  const codec = createBackupCodec();
  const controller = new AbortController();
  const pending = codec.seal(original.secret, password, controller.signal);
  await assert.rejects(
    codec.seal(original.secret, password),
    coded(BACKUP_ERROR.BUSY),
  );
  controller.abort();
  await assert.rejects(pending, coded(BACKUP_ERROR.CANCELLED));
  await assert.rejects(
    codec.seal(original.secret, password, controller.signal),
    coded(BACKUP_ERROR.CANCELLED),
  );
  assert.ok((await codec.seal(original.secret, password)).length > 0);
});
