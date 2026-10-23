// Parses the additive public v2 family, reusing v1 primitive rules without changing v1 wire contracts.
import { canonicalJson } from './canonical.js';
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_RECORD_VERSION,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  REASONING_LEVELS,
} from './constants.js';
import type { PublicRecordV2 } from './control-types.js';
import {
  controlArray,
  controlFail,
  controlObject,
  controlPrimitive,
  controlReasoning,
} from './control-validation.js';
import { parsePublicRecord } from './public-parser.js';

function modelInputV2(value: unknown) {
  const input = controlObject(value, [
    'modelId',
    'variant',
    'quantization',
    'contextTokens',
    'pricing',
    'reasoning',
  ]);
  const reasoning = controlArray(
    input.reasoning,
    Object.keys(REASONING_LEVELS).length,
  ).map(controlReasoning);
  if (!reasoning.length || new Set(reasoning).size !== reasoning.length)
    return controlFail();
  return {
    reasoning,
    model: {
      modelId: input.modelId,
      variant: input.variant,
      quantization: input.quantization,
      contextTokens: input.contextTokens,
      pricing: input.pricing,
    },
  };
}

export function parsePublicV2(value: unknown): PublicRecordV2 {
  const kind: unknown =
    value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'kind')?.value
      : undefined;
  const extra =
    kind === PUBLIC_RECORD_KINDS.CATALOG
      ? ['models', 'dataPolicy']
      : kind === PUBLIC_RECORD_KINDS.PRESENCE
        ? ['catalogDigest', 'state']
        : kind === PUBLIC_RECORD_KINDS.WITHDRAWAL
          ? ['catalogDigest']
          : controlFail();
  const input = controlObject(value, [
    'schemaVersion',
    'kind',
    'owner',
    'nodeId',
    'sequence',
    'issuedAt',
    'expiresAt',
    ...extra,
  ]);
  if (input.schemaVersion !== CONTROL_RECORD_VERSION)
    return controlFail(CONTROL_CODES.VERSION);
  const models =
    kind === PUBLIC_RECORD_KINDS.CATALOG
      ? controlArray(input.models, PUBLIC_RECORD_LIMITS.maxModels).map(
          modelInputV2,
        )
      : [];
  const legacy = controlPrimitive(() =>
    parsePublicRecord({
      ...input,
      schemaVersion: PUBLIC_RECORD_LIMITS.schemaVersion,
      ...(kind === PUBLIC_RECORD_KINDS.CATALOG
        ? { models: models.map((item) => item.model) }
        : {}),
    }),
  );
  const result: PublicRecordV2 =
    legacy.kind === PUBLIC_RECORD_KINDS.CATALOG
      ? {
          ...legacy,
          schemaVersion: CONTROL_RECORD_VERSION,
          models: legacy.models.map((model, index) => ({
            ...model,
            reasoning: models[index]!.reasoning,
          })),
        }
      : { ...legacy, schemaVersion: CONTROL_RECORD_VERSION };
  if (
    new TextEncoder().encode(canonicalJson(result)).byteLength >
    PUBLIC_RECORD_LIMITS.maxWireBytes
  )
    return controlFail(CONTROL_CODES.LIMIT);
  return result;
}
