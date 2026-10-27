// Validates the RPC account batch envelope before interpreting null accounts as absence.
// Malformed provider data is a lookup failure, never a disqualified or revoked chain identity.
import { getBase64Decoder, getBase64Encoder, isAddress } from '@solana/kit';

import { BASE64_ENCODING, IDENTITY_ERROR_CODES, PROGRAMS } from './constants';
import { IdentityError } from './errors';

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_TEXT_TO_BYTES = getBase64Encoder();
const BASE64_BYTES_TO_TEXT = getBase64Decoder();
function invalid(): never {
  throw new IdentityError(
    IDENTITY_ERROR_CODES.RPC_RESPONSE_INVALID,
    'Registry RPC response is malformed.',
  );
}
function account(value: unknown) {
  if (value === null) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    !('owner' in value) ||
    typeof value.owner !== 'string' ||
    !isAddress(value.owner) ||
    !('data' in value) ||
    !Array.isArray(value.data)
  )
    return invalid();
  const data: unknown[] = value.data;
  if (
    data.length !== 2 ||
    data[1] !== BASE64_ENCODING ||
    typeof data[0] !== 'string' ||
    !BASE64_PATTERN.test(data[0])
  )
    return invalid();
  try {
    const bytes = new Uint8Array(BASE64_TEXT_TO_BYTES.encode(data[0]));
    if (BASE64_BYTES_TO_TEXT.decode(bytes) !== data[0]) return invalid();
    return { owner: value.owner, data: bytes };
  } catch {
    return invalid();
  }
}
export function decodeAccountBatch(value: unknown, requested: number) {
  if (!Array.isArray(value) || value.length !== requested) return invalid();
  const accounts: unknown[] = value;
  return accounts.map(account);
}

export function decodeProgramAccounts(value: unknown) {
  if (!Array.isArray(value)) return invalid();
  const rows: unknown[] = value;
  return rows.map((row) => {
    if (
      !row ||
      typeof row !== 'object' ||
      !('pubkey' in row) ||
      typeof row.pubkey !== 'string' ||
      !isAddress(row.pubkey) ||
      !('account' in row)
    )
      return invalid();
    const decoded = account(row.account);
    if (!decoded || decoded.owner !== PROGRAMS.registry) return invalid();
    return decoded;
  });
}
