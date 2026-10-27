// Authenticates the active address with its protected wallet key; no custody changes.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { WALLET_LIBRARY, WALLET_LIBRARY_ERROR } from './constants';
import { WalletLibraryError } from './library-error';

function tag(secret: string, address: string) {
  const key = Buffer.from(secret, 'base64');
  try {
    return createHmac(WALLET_LIBRARY.MAC_ALGORITHM, key)
      .update(WALLET_LIBRARY.DOMAIN)
      .update(JSON.stringify([WALLET_LIBRARY.VERSION, address]))
      .digest();
  } finally {
    key.fill(0);
  }
}
export function selectedAddress(text: string) {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'address,mac,version' ||
    !('version' in value) ||
    value.version !== WALLET_LIBRARY.VERSION ||
    !('address' in value) ||
    typeof value.address !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.address) ||
    !('mac' in value) ||
    typeof value.mac !== 'string'
  )
    throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
  return { address: value.address, mac: value.mac };
}
export function selectionText(secret: string, address: string) {
  const mac = tag(secret, address);
  try {
    return JSON.stringify({
      version: WALLET_LIBRARY.VERSION,
      address,
      mac: mac.toString('base64'),
    });
  } finally {
    mac.fill(0);
  }
}
export function checkSelection(text: string, secret: string, address: string) {
  const value = selectedAddress(text);
  const expected = tag(secret, address);
  const actual = Buffer.from(value.mac, 'base64');
  try {
    if (
      value.address !== address ||
      actual.toString('base64') !== value.mac ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new WalletLibraryError(WALLET_LIBRARY_ERROR.RECOVERY_REQUIRED);
  } finally {
    expected.fill(0);
    actual.fill(0);
  }
}
