// Owns record checks for the index, composed only from @gyblos/protocol public v2 verification.
// Self-signature first (so limits apply to proven NodeIds), then verifyPublicV2 with the stored catalog.
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  PUBLIC_RECORD_KINDS,
  PUBLIC_V2_DOMAINS,
} from '@gyblos/protocol/constants';
import type {
  PublicCatalogV2,
  PublicRecordV2,
  PublicTrustV2,
} from '@gyblos/protocol/control-types';
import {
  controlFail,
  controlHex,
  controlObject,
  controlVerify,
} from '@gyblos/protocol/control-validation';
import {
  parsePublicV2,
  validatePublicV2Time,
  verifyPublicV2,
} from '@gyblos/protocol/public-v2';

import { INDEX_ERRORS } from './constants';
import { indexFail, protocolStep, recordCode, referenceCode } from './errors';
import type { StoredCatalog } from './storage';

const HEX_PAIR = 2;
const HEX_RADIX = 16;

export interface SelfSigned {
  record: PublicRecordV2;
  signature: string;
}

// Input is already validated lowercase hex of the expected length.
function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    { length: value.length / HEX_PAIR },
    (_unused, index) =>
      Number.parseInt(
        value.slice(index * HEX_PAIR, (index + 1) * HEX_PAIR),
        HEX_RADIX,
      ),
  );
}

// Shape, lifetime (zero skew) and the Ed25519 signature by the record's own NodeId under its
// v2 domain. Proves only self-signing, never ownership.
export function verifySelfSigned(envelope: unknown, now: number) {
  return protocolStep(async (): Promise<SelfSigned> => {
    const input = controlObject(envelope, ['record', 'signature']);
    const record = parsePublicV2(input.record);
    validatePublicV2Time(record, now);
    const signature = controlHex(
      input.signature,
      CONTROL_LIMITS.signatureBytes,
    );
    const valid = await controlVerify(
      PUBLIC_V2_DOMAINS[record.kind],
      record,
      hexToBytes(record.nodeId),
      hexToBytes(signature),
    );
    if (!valid) controlFail(CONTROL_CODES.SIGNATURE);
    return { record, signature };
  }, recordCode);
}

// The stored catalog was fully verified when accepted; parse it back into a typed record.
function storedCatalogRecord(stored: StoredCatalog): PublicCatalogV2 {
  const envelope: unknown = JSON.parse(stored.json);
  const record = parsePublicV2(
    envelope && typeof envelope === 'object'
      ? Reflect.get(envelope, 'record')
      : null,
  );
  return record.kind === PUBLIC_RECORD_KINDS.CATALOG ? record : controlFail();
}

// Authoritative check through verifyPublicV2. Presence and withdrawal must reference the
// NodeId's current, live, non-withdrawn stored catalog (referenceV2 rules).
export async function verifyAgainstStored(
  envelope: unknown,
  record: PublicRecordV2,
  catalog: StoredCatalog | null,
  now: number,
) {
  const trust: PublicTrustV2 = {
    owner: record.owner,
    nodeId: record.nodeId,
    now,
  };
  if (record.kind === PUBLIC_RECORD_KINDS.CATALOG)
    return protocolStep(() => verifyPublicV2(envelope, trust), recordCode);
  if (!catalog || catalog.withdrawn || catalog.expiresAt <= now)
    return indexFail(INDEX_ERRORS.UNKNOWN_CATALOG);
  return protocolStep(
    () =>
      verifyPublicV2(envelope, {
        ...trust,
        catalog: storedCatalogRecord(catalog),
      }),
    referenceCode,
  );
}
