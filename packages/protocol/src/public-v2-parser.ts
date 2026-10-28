// Parses the additive public v2 family, reusing v1 primitive rules without changing v1 wire contracts.
import { canonicalJson } from './canonical';
import {
  CONTROL_CODES,
  CONTROL_LIMITS,
  CONTROL_RECORD_VERSION,
  PUBLIC_PRICE_UNIT,
  PUBLIC_RECORD_KINDS,
  PUBLIC_RECORD_LIMITS,
  REASONING_LEVELS,
} from './constants';
import type { PublicRecordV2 } from './control-types';
import {
  controlArray,
  controlFail,
  controlObject,
  controlPrimitive,
  controlReasoning,
} from './control-validation';
import { parsePublicPricesV2 } from './pricing-v2';
import { parsePublicRecord } from './public-parser';

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
  const pricing = parsePublicPricesV2(input.pricing);
  return {
    reasoning,
    pricing,
    model: {
      modelId: input.modelId,
      variant: input.variant,
      quantization: input.quantization,
      contextTokens: input.contextTokens,
      // Internal metadata-validation projection only; this is never signed or returned as v1.
      pricing: {
        network: pricing.network,
        asset: pricing.asset,
        unit: PUBLIC_PRICE_UNIT,
        inputAtomic: pricing.inputAtomicPerMtok,
        outputAtomic: pricing.outputAtomicPerMtok,
      },
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
            pricing: models[index]!.pricing,
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
