// Owns domain-separated bytes and Ed25519 verification through Web Crypto.
// Wallet adaptation and signature serialization belong to callers.
import { canonicalJson } from './canonical';

export type Signer = (
  bytes: Uint8Array<ArrayBuffer>,
) => Promise<Readonly<Uint8Array>>;

export function signingBytes(
  domain: string,
  value: unknown,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(domain + canonicalJson(value));
}

export async function sign(
  domain: string,
  value: unknown,
  signer: Signer,
): Promise<Readonly<Uint8Array>> {
  return signer(signingBytes(domain, value));
}

export async function verify(
  domain: string,
  value: unknown,
  publicKeyBytes: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const publicKey = await crypto.subtle.importKey(
    'raw',
    publicKeyBytes,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'Ed25519',
    publicKey,
    signature,
    signingBytes(domain, value),
  );
}
