import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { dirname } from 'node:path';

import { getAddressDecoder } from '@solana/kit';

import {
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFileOnce,
} from '@gyblos/runtime/private-file';

import { MODEL_VERIFIER_CODES, ModelVerifierError } from './constants';

const SEED_BYTES = 32;
const KEY_FILE_BYTES = 256;
const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';

export interface VerifierKey {
  address: string;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

function fromSeed(seed: Buffer): VerifierKey {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from(PKCS8_ED25519_PREFIX, 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
  return {
    address: getAddressDecoder().decode(publicKey),
    sign: async (bytes) => sign(null, bytes, key),
  };
}

export function ephemeralAddress(): string {
  return fromSeed(randomBytes(SEED_BYTES)).address;
}

function parseSeed(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.INVALID_KEY);
  }
  const seed =
    value && typeof value === 'object' ? Reflect.get(value, 'seed') : undefined;
  if (typeof seed !== 'string' || !/^[0-9a-f]{64}$/.test(seed))
    throw new ModelVerifierError(MODEL_VERIFIER_CODES.INVALID_KEY);
  return Buffer.from(seed, 'hex');
}

export async function loadVerifierKey(
  path: string,
  create: boolean,
): Promise<VerifierKey> {
  const existing = await readPrivateFile(path, KEY_FILE_BYTES);
  if (existing !== undefined) return fromSeed(parseSeed(existing));
  if (!create) throw new ModelVerifierError(MODEL_VERIFIER_CODES.INVALID_KEY);
  await ensurePrivateDirectory(dirname(path));
  const seed = randomBytes(SEED_BYTES);
  await writePrivateFileOnce(
    path,
    `${JSON.stringify({ seed: seed.toString('hex') })}\n`,
    KEY_FILE_BYTES,
  );
  return fromSeed(parseSeed((await readPrivateFile(path, KEY_FILE_BYTES))!));
}
