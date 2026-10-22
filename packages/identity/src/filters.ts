// Owns construction of getProgramAccounts memcmp filters from raw bytes.
// Must not know which 8004 fields are filtered on; callers pass offsets.
import { getBase58Decoder, type Base58EncodedBytes } from '@solana/kit';

import { IDENTITY_ERROR_CODES } from './constants.js';
import { IdentityError } from './errors.js';

const BASE58 = getBase58Decoder();
const BASE58_ALPHABET = /^[1-9A-HJ-NP-Za-km-z]*$/;
const BASE58_ENCODING = 'base58' as const;

function isBase58(text: string): text is Base58EncodedBytes {
  return BASE58_ALPHABET.test(text);
}

export function memcmpFilter(offset: bigint, bytes: Uint8Array) {
  const encoded = BASE58.decode(bytes);
  if (!isBase58(encoded)) {
    throw new IdentityError(
      IDENTITY_ERROR_CODES.ENCODING_INVARIANT,
      'base58 encoder produced invalid output',
    );
  }
  return { memcmp: { offset, bytes: encoded, encoding: BASE58_ENCODING } };
}
