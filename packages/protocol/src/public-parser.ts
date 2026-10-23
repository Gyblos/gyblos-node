// Parses public catalog/presence/withdrawal JSON into detached, allowlisted values.
// Rejects private endpoint/engine fields; it does not parse the private paid offer.
import { canonicalJson } from './canonical.js';
import {
  DATA_RETENTION,
  PUBLIC_PRESENCE_STATE,
  PUBLIC_PRICE_UNIT,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
} from './constants.js';
import type { PublicModelListing, PublicRecord } from './public-types.js';
import {
  invalidRecord,
  publicAddress,
  publicHex,
  publicIdentifier,
  publicInteger,
  publicObject,
} from './public-validation.js';

const HEADER_KEYS = [
  'schemaVersion',
  'kind',
  'owner',
  'nodeId',
  'sequence',
  'issuedAt',
  'expiresAt',
];
const MODEL_KEYS = [
  'modelId',
  'variant',
  'quantization',
  'contextTokens',
  'pricing',
];
const PRICE_KEYS = ['network', 'asset', 'unit', 'inputAtomic', 'outputAtomic'];

function atomicAmount(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > PUBLIC_RECORD_LIMITS.maxAtomicDigits ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > BigInt(PUBLIC_RECORD_LIMITS.maxAtomic)
  )
    return invalidRecord();
  return value;
}

function parseModel(value: unknown): PublicModelListing {
  const model = publicObject(value, MODEL_KEYS);
  const pricing = publicObject(model.pricing, PRICE_KEYS);
  if (
    typeof pricing.network !== 'string' ||
    !/^solana:[A-Za-z0-9]{1,32}$/.test(pricing.network) ||
    pricing.unit !== PUBLIC_PRICE_UNIT
  )
    return invalidRecord();
  return {
    modelId: publicIdentifier(model.modelId),
    variant: model.variant === null ? null : publicIdentifier(model.variant),
    quantization:
      model.quantization === null ? null : publicIdentifier(model.quantization),
    contextTokens: publicInteger(
      model.contextTokens,
      1,
      PUBLIC_RECORD_LIMITS.maxContextTokens,
    ),
    pricing: {
      network: pricing.network,
      asset: publicAddress(pricing.asset),
      unit: PUBLIC_PRICE_UNIT,
      inputAtomic: atomicAmount(pricing.inputAtomic),
      outputAtomic: atomicAmount(pricing.outputAtomic),
    },
  };
}

function parseModels(value: unknown): PublicModelListing[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > PUBLIC_RECORD_LIMITS.maxModels ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalidRecord();
  const models: PublicModelListing[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      return invalidRecord();
    const model = parseModel(descriptor.value);
    const identity = canonicalJson([
      model.modelId,
      model.variant,
      model.quantization,
    ]);
    if (seen.has(identity)) return invalidRecord();
    seen.add(identity);
    models.push(model);
  }
  return models;
}

function parseRecord(value: unknown): PublicRecord {
  // Inspect the descriptor before reading kind: arbitrary accessors are not JSON.
  if (!value || typeof value !== 'object') return invalidRecord();
  const kind: unknown = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  const extra =
    kind === PUBLIC_RECORD_KINDS.CATALOG
      ? ['models', 'dataPolicy']
      : kind === PUBLIC_RECORD_KINDS.PRESENCE
        ? ['catalogDigest', 'state']
        : kind === PUBLIC_RECORD_KINDS.WITHDRAWAL
          ? ['catalogDigest']
          : invalidRecord();
  const record = publicObject(value, [...HEADER_KEYS, ...extra]);
  if (record.schemaVersion !== PUBLIC_RECORD_LIMITS.schemaVersion)
    return invalidRecord();
  const header = {
    schemaVersion: PUBLIC_RECORD_LIMITS.schemaVersion,
    owner: publicAddress(record.owner),
    nodeId: publicHex(record.nodeId, PUBLIC_RECORD_LIMITS.publicKeyBytes),
    sequence: publicInteger(record.sequence, 1),
    issuedAt: publicInteger(record.issuedAt),
    expiresAt: publicInteger(record.expiresAt),
  };
  if (kind === PUBLIC_RECORD_KINDS.CATALOG) {
    const policy = publicObject(record.dataPolicy, ['retention']);
    const retention = policy.retention;
    if (
      retention !== DATA_RETENTION.NONE &&
      retention !== DATA_RETENTION.MAY_RETAIN &&
      retention !== DATA_RETENTION.UNSPECIFIED
    )
      return invalidRecord();
    return {
      ...header,
      kind,
      models: parseModels(record.models),
      dataPolicy: { retention },
    };
  }
  const catalogDigest = publicHex(
    record.catalogDigest,
    PUBLIC_RECORD_LIMITS.publicKeyBytes,
  );
  if (kind === PUBLIC_RECORD_KINDS.PRESENCE) {
    if (record.state !== PUBLIC_PRESENCE_STATE) return invalidRecord();
    return { ...header, kind, catalogDigest, state: PUBLIC_PRESENCE_STATE };
  }
  return { ...header, kind: PUBLIC_RECORD_KINDS.WITHDRAWAL, catalogDigest };
}

export function parsePublicRecord(value: unknown): PublicRecord {
  const record = parseRecord(value);
  if (
    new TextEncoder().encode(canonicalJson(record)).byteLength >
    PUBLIC_RECORD_LIMITS.maxWireBytes
  )
    return invalidRecord();
  return record;
}
