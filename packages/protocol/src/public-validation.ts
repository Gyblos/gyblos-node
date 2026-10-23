// Validates bounded JSON primitives for public discovery contracts only.
// Private offers keep the separate canonicalJson rules in canonical.ts.
import {
  PUBLIC_RECORD_ERROR_CODES,
  PUBLIC_RECORD_LIMITS,
  type PublicRecordErrorCode,
} from './constants.js';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BYTE_RADIX = 256n;
const HEX_RADIX = 16;

export class PublicRecordError extends Error {
  constructor(readonly code: PublicRecordErrorCode) {
    super(code);
    this.name = 'PublicRecordError';
  }
}

export function invalidRecord(): never {
  throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_RECORD);
}

export function publicObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object') return invalidRecord();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return invalidRecord();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length) return invalidRecord();
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !keys.includes(key) ||
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      return invalidRecord();
  }
  return value as Record<string, unknown>;
}

export function publicInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return invalidRecord();
  return value;
}

export function publicIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > PUBLIC_RECORD_LIMITS.maxIdentifierCharacters ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._:-]*)*$/.test(
      value,
    )
  )
    return invalidRecord();
  return value;
}

export function publicHex(value: unknown, bytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length !== bytes * PUBLIC_RECORD_LIMITS.hexCharactersPerByte ||
    !/^[0-9a-f]+$/.test(value)
  )
    return invalidRecord();
  return value;
}

export function publicAddress(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < PUBLIC_RECORD_LIMITS.minAddressCharacters ||
    value.length > PUBLIC_RECORD_LIMITS.maxAddressCharacters
  )
    return invalidRecord();
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return invalidRecord();
    decoded = decoded * BigInt(BASE58_ALPHABET.length) + BigInt(digit);
  }
  let bytes = value.length - value.replace(/^1+/, '').length;
  while (decoded > 0n) {
    decoded /= BYTE_RADIX;
    bytes++;
  }
  if (bytes !== PUBLIC_RECORD_LIMITS.publicKeyBytes) return invalidRecord();
  return value;
}

export function hexBytes(value: string): Uint8Array<ArrayBuffer> {
  const width = PUBLIC_RECORD_LIMITS.hexCharactersPerByte;
  return Uint8Array.from({ length: value.length / width }, (_, index) =>
    Number.parseInt(value.slice(index * width, (index + 1) * width), HEX_RADIX),
  );
}

export function bytesHex(value: Readonly<Uint8Array>): string {
  return Array.from(value, (byte) =>
    byte
      .toString(HEX_RADIX)
      .padStart(PUBLIC_RECORD_LIMITS.hexCharactersPerByte, '0'),
  ).join('');
}

// Decode a validated Solana public address without a wallet SDK.
export function publicAddressBytes(value: unknown): Uint8Array<ArrayBuffer> {
  const text = publicAddress(value);
  let decoded = 0n;
  for (const character of text)
    decoded =
      decoded * BigInt(BASE58_ALPHABET.length) +
      BigInt(BASE58_ALPHABET.indexOf(character));
  const result = new Uint8Array(PUBLIC_RECORD_LIMITS.publicKeyBytes);
  for (let index = result.length - 1; index >= 0; index--) {
    result[index] = Number(decoded % BYTE_RADIX);
    decoded /= BYTE_RADIX;
  }
  return result;
}
