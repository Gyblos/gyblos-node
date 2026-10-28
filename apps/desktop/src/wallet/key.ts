// Creates and validates local Ed25519 material; exports no signing or payment API.
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from 'node:crypto';

import { getBase58Decoder } from '@solana/kit';

import { WALLET } from './constants';

export function createWalletSecret() {
  const pair = generateKeyPairSync('ed25519');
  const bytes = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  try {
    return bytes.toString('base64');
  } finally {
    bytes.fill(0);
  }
}

export function walletAddress(secret: string) {
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(secret) ||
    secret.length > WALLET.MAX_SECRET_BYTES
  )
    throw new Error('Invalid local wallet.');
  const bytes = Buffer.from(secret, 'base64');
  try {
    if (bytes.toString('base64') !== secret)
      throw new Error('Invalid local wallet.');
    const key = createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519')
      throw new Error('Invalid local wallet.');
    const publicKey = createPublicKey(key).export({ format: 'jwk' });
    if (!publicKey.x) throw new Error('Invalid local wallet.');
    return getBase58Decoder().decode(Buffer.from(publicKey.x, 'base64url'));
  } finally {
    bytes.fill(0);
  }
}
