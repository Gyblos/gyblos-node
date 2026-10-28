// The Ollama engine plugin: refuses offers the daemon's managed Ollama cannot serve (model, then engine,
// then reasoning, as before) and builds the engine with recounted metering and the pinned warmup policy.
import { READINESS_GENERATION } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { MODEL } from '@gyblos/engine-ollama/model';
import {
  CONTROL_METERING_MODES,
  MODEL_CLASSIFICATIONS,
} from '@gyblos/protocol/constants';

import { modelTokenizer } from './artifacts';
import { NODE_ERROR_CODES } from './constants';
import type {
  EngineFactory,
  EngineReadinessPolicy,
  SellerEngineOffer,
} from './engine-factory';
import { SERVED_OFFER } from './seller-offer';

export const OLLAMA_READINESS = {
  warmup: {
    prompt: READINESS_GENERATION.prompt,
    maxTokens: READINESS_GENERATION.maxTokens,
  },
  residencyMs: READINESS_GENERATION.residencyMs,
} as const satisfies EngineReadinessPolicy;

// The listed selection for a model served by the managed Ollama: the pinned quantization, no variant.
export function ollamaSelection(modelId: string) {
  return { modelId, variant: null, quantization: MODEL.quantization };
}

function refuse(offer: SellerEngineOffer) {
  const { model, engine, reasoning } = offer;
  if (
    model.kind !== MODEL_CLASSIFICATIONS.CATALOG ||
    model.id !== SERVED_OFFER.modelId
  )
    return NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED;
  if (
    new URL(engine.url).origin !== new URL(SERVED_OFFER.engineUrl).origin ||
    engine.apiKeyEnv !== undefined ||
    (engine.upstreamModel !== undefined && engine.upstreamModel !== MODEL.name)
  )
    return NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED;
  const served: readonly string[] = SERVED_OFFER.reasoning;
  if (!reasoning.length || reasoning.some((level) => !served.includes(level)))
    return NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED;
  return undefined;
}

export const OLLAMA_ENGINE_FACTORY: EngineFactory = {
  refuse,
  // The daemon's managed Ollama; PR 2c moves the engine to the offer URL.
  create: (offer, { fetch, environment }) => ({
    engine: createOllamaEngine(SERVED_OFFER.engineUrl, fetch),
    selection: ollamaSelection(offer.model.id),
    metering: {
      mode: CONTROL_METERING_MODES.RECOUNTED,
      tokenizer: () => modelTokenizer(environment),
    },
    readiness: OLLAMA_READINESS,
  }),
};
