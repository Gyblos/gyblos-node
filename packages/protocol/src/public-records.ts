// Authenticates public discovery records with the Iroh node's Ed25519 key.
// Registry trust, sequence persistence, discovery I/O and payment policy stay outside.
import {
  PUBLIC_RECORD_DOMAINS,
  PUBLIC_RECORD_ERROR_CODES,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from './constants';
import { parsePublicRecord } from './public-parser';
import type {
  PublicCatalog,
  PublicRecord,
  PublicRecordTrust,
  SignedPublicRecord,
} from './public-types';
import {
  bytesHex,
  hexBytes,
  invalidRecord,
  publicObject,
  PublicRecordError,
} from './public-validation';
import { sign, signingBytes, verify, type Signer } from './signing';

export { parsePublicRecord } from './public-parser';
export { PublicRecordError } from './public-validation';

function validateTime(record: PublicRecord, now: number) {
  const lifetime =
    record.kind === PUBLIC_RECORD_KINDS.PRESENCE
      ? PUBLIC_RECORD_LIMITS.presenceLifetimeMs
      : record.kind === PUBLIC_RECORD_KINDS.CATALOG
        ? PUBLIC_RECORD_LIMITS.catalogLifetimeMs
        : PUBLIC_RECORD_LIMITS.withdrawalLifetimeMs;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    record.issuedAt > now ||
    record.expiresAt <= now ||
    record.expiresAt <= record.issuedAt ||
    record.expiresAt - record.issuedAt > lifetime
  )
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_TIME);
}

function validateSequence(
  record: PublicRecord,
  lastSequence: number | undefined,
) {
  if (
    lastSequence !== undefined &&
    (!Number.isSafeInteger(lastSequence) ||
      lastSequence < 0 ||
      record.sequence <= lastSequence)
  )
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.STALE_SEQUENCE);
}

function signatureBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length !==
      PUBLIC_RECORD_LIMITS.signatureBytes *
        PUBLIC_RECORD_LIMITS.hexCharactersPerByte ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_SIGNATURE);
  return hexBytes(value);
}

async function validateReference(
  record: PublicRecord,
  value: PublicCatalog | undefined,
  now: number,
) {
  if (record.kind === PUBLIC_RECORD_KINDS.CATALOG) return;
  if (!value)
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_REFERENCE);
  const catalog = parsePublicRecord(value);
  if (
    catalog.kind !== PUBLIC_RECORD_KINDS.CATALOG ||
    catalog.owner !== record.owner ||
    catalog.nodeId !== record.nodeId ||
    catalog.sequence >= record.sequence ||
    catalog.issuedAt > record.issuedAt ||
    catalog.expiresAt < record.expiresAt
  )
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_REFERENCE);
  validateTime(catalog, now);
  if ((await catalogDigest(catalog)) !== record.catalogDigest)
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_REFERENCE);
}

export async function catalogDigest(value: PublicCatalog): Promise<string> {
  const catalog = parsePublicRecord(value);
  if (catalog.kind !== PUBLIC_RECORD_KINDS.CATALOG) return invalidRecord();
  const digest = await crypto.subtle.digest(
    'SHA-256',
    signingBytes(PUBLIC_RECORD_DOMAINS.catalog, catalog),
  );
  return bytesHex(new Uint8Array(digest));
}

export async function signPublicRecord(
  value: PublicRecord,
  signer: Signer,
): Promise<SignedPublicRecord> {
  const record = parsePublicRecord(value);
  validateTime(record, record.issuedAt);
  const signature = await sign(
    PUBLIC_RECORD_DOMAINS[record.kind],
    record,
    signer,
  );
  if (signature.length !== PUBLIC_RECORD_LIMITS.signatureBytes)
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_SIGNATURE);
  return { record, signature: bytesHex(signature) };
}

export async function verifyPublicRecord(
  value: unknown,
  trust: PublicRecordTrust,
): Promise<PublicRecord> {
  const envelope = publicObject(value, ['record', 'signature']);
  const record = parsePublicRecord(envelope.record);
  if (record.owner !== trust.owner || record.nodeId !== trust.nodeId)
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.UNTRUSTED_IDENTITY);
  validateTime(record, trust.now);
  validateSequence(record, trust.lastSequence);
  const signature = signatureBytes(envelope.signature);
  await validateReference(record, trust.catalog, trust.now);
  let valid = false;
  try {
    valid = await verify(
      PUBLIC_RECORD_DOMAINS[record.kind],
      record,
      hexBytes(record.nodeId),
      signature,
    );
  } catch {
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_SIGNATURE);
  }
  if (!valid)
    throw new PublicRecordError(PUBLIC_RECORD_ERROR_CODES.INVALID_SIGNATURE);
  return record;
}
