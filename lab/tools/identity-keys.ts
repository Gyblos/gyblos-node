// Owns laboratory throwaway identity keys in <lab home>/identity/keys (dir 0700, files 0600).
// Devnet/local test keys only; never prints secret bytes. Product code must not depend on this module.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  createKeyPairFromPrivateKeyBytes,
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getAddressFromPublicKey,
  type KeyPairSigner,
} from '@solana/kit';

import { FILE_MODES, labLayout, LEGACY_LOCAL_PATHS } from '@gyblos/config';
import { assertNoLegacyLayout } from '@gyblos/node/home';

const SEED_BYTES = 32;
const KEY_NAME = /^[a-z0-9-]+$/;

function parseSecret(text: string): Uint8Array {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((item) => Number.isInteger(item)))
    throw new Error('bad key file');
  return Uint8Array.from(parsed.map(Number));
}

async function createSecret(): Promise<Uint8Array> {
  const seed = crypto.getRandomValues(new Uint8Array(SEED_BYTES));
  const keyPair = await createKeyPairFromPrivateKeyBytes(seed, true);
  const publicBytes = getAddressEncoder().encode(
    await getAddressFromPublicKey(keyPair.publicKey),
  );
  return Uint8Array.from([...seed, ...publicBytes]);
}

export async function loadOrCreateKey(
  name: string,
): Promise<{ signer: KeyPairSigner; seed: Uint8Array }> {
  if (!KEY_NAME.test(name)) throw new Error('key name must be [a-z0-9-]+');
  const directory = labLayout(process.env).identityKeys;
  await assertNoLegacyLayout(directory, [LEGACY_LOCAL_PATHS.identityKeys]);
  mkdirSync(directory, { recursive: true, mode: FILE_MODES.privateDirectory });
  chmodSync(directory, FILE_MODES.privateDirectory);
  const file = join(directory, `${name}.json`);
  if (!existsSync(file))
    writeFileSync(file, JSON.stringify([...(await createSecret())]), {
      mode: FILE_MODES.privateFile,
    });
  chmodSync(file, FILE_MODES.privateFile);
  const secret = parseSecret(readFileSync(file, 'utf8'));
  return {
    signer: await createKeyPairSignerFromBytes(secret),
    seed: secret.slice(0, SEED_BYTES),
  };
}
