// Signs the additive public family with node keys; identity resolution and cache persistence stay outside.
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_RECORD_VERSION,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  PUBLIC_V2_DOMAINS,
} from './constants';
import type {
  PublicCatalogV2,
  PublicRecordV2,
  PublicTrustV2,
  SignedPublicV2,
} from './control-types';
import {
  controlFail,
  controlHex,
  controlInteger,
  controlObject,
  controlVerify,
} from './control-validation';
import { parsePublicV2 } from './public-v2-parser';
import { bytesHex, hexBytes } from './public-validation';
import { sign, signingBytes, type Signer } from './signing';

export { parsePublicV2 } from './public-v2-parser';
export function validatePublicV2Time(record: PublicRecordV2, now: number) {
  controlInteger(now);
  const lifetime =
    record.kind === PUBLIC_RECORD_KINDS.PRESENCE
      ? PUBLIC_RECORD_LIMITS.presenceLifetimeMs
      : record.kind === PUBLIC_RECORD_KINDS.WITHDRAWAL
        ? PUBLIC_RECORD_LIMITS.withdrawalLifetimeMs
        : PUBLIC_RECORD_LIMITS.catalogLifetimeMs;
  if (
    record.issuedAt > now ||
    record.expiresAt <= now ||
    record.expiresAt <= record.issuedAt ||
    record.expiresAt - record.issuedAt > lifetime
  )
    return controlFail(CONTROL_CODES.EXPIRED);
}
export async function catalogDigestV2(value: unknown) {
  const catalog = parsePublicV2(value);
  if (catalog.kind !== PUBLIC_RECORD_KINDS.CATALOG) return controlFail();
  return bytesHex(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        signingBytes(PUBLIC_V2_DOMAINS[PUBLIC_RECORD_KINDS.CATALOG], catalog),
      ),
    ),
  );
}
export async function signPublicV2(
  value: PublicRecordV2,
  signer: Signer,
): Promise<SignedPublicV2> {
  const record = parsePublicV2(value);
  validatePublicV2Time(record, record.issuedAt);
  const signature = Uint8Array.from(
    await sign(PUBLIC_V2_DOMAINS[record.kind], record, signer),
  );
  if (
    signature.length !== CONTROL_LIMITS.signatureBytes ||
    !(await controlVerify(
      PUBLIC_V2_DOMAINS[record.kind],
      record,
      hexBytes(record.nodeId),
      signature,
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return { record, signature: bytesHex(signature) };
}
async function referenceV2(
  record: PublicRecordV2,
  trusted: PublicCatalogV2 | undefined,
  now: number,
) {
  if (record.kind === PUBLIC_RECORD_KINDS.CATALOG) return;
  const catalog = parsePublicV2(trusted);
  if (
    catalog.kind !== PUBLIC_RECORD_KINDS.CATALOG ||
    catalog.owner !== record.owner ||
    catalog.nodeId !== record.nodeId ||
    catalog.sequence >= record.sequence ||
    catalog.issuedAt > record.issuedAt ||
    catalog.expiresAt < record.expiresAt
  )
    return controlFail(CONTROL_CODES.STALE);
  validatePublicV2Time(catalog, now);
  if (record.catalogDigest !== (await catalogDigestV2(catalog)))
    return controlFail(CONTROL_CODES.STALE);
}
export async function verifyPublicV2(
  value: unknown,
  trust: PublicTrustV2,
): Promise<PublicRecordV2> {
  const input = controlObject(value, ['record', 'signature']);
  const record = parsePublicV2(input.record);
  if (record.owner !== trust.owner || record.nodeId !== trust.nodeId)
    return controlFail(CONTROL_CODES.POLICY);
  validatePublicV2Time(record, trust.now);
  if (
    trust.lastSequence !== undefined &&
    record.sequence <= controlInteger(trust.lastSequence)
  )
    return controlFail(CONTROL_CODES.STALE);
  await referenceV2(record, trust.catalog, trust.now);
  const signature = hexBytes(
    controlHex(input.signature, CONTROL_LIMITS.signatureBytes),
  );
  if (
    !(await controlVerify(
      PUBLIC_V2_DOMAINS[record.kind],
      record,
      hexBytes(record.nodeId),
      signature,
    ))
  )
    return controlFail(CONTROL_CODES.SIGNATURE);
  return record;
}
// Consumers must use separate replay namespaces for each public family version.
export function publicV2CacheKey(owner: string, nodeId: string) {
  return `${CONTROL_RECORD_VERSION}:${owner}:${nodeId}`;
}
