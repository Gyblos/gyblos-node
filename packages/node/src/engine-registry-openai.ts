// The OpenAI-compatible engine plugin: serves any model at an https URL or a literal loopback server,
// with reasoning off (other levels arrive per provider later). A model whose public tokenizer the seller
// pins is recounted; any other is declared by its provider. A loopback server runs on this machine and is
// warmed like Ollama; a remote API is only described for readiness, so readiness never spends the
// seller's credit. The API key is read from the variable the offer names and reaches only the engine.
import { OPENAI_LOCAL_READINESS } from '@gyblos/engine-openai/constants';
import { createOpenAiEngine } from '@gyblos/engine-openai/engine';
import {
  CONTROL_METERING_MODES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { modelTokenizer } from './artifacts';
import { NODE_ERROR_CODES } from './constants';
import {
  REMOTE_READINESS,
  type EngineFactory,
  type EngineReadinessPolicy,
  type SellerEngineOffer,
} from './engine-factory';
import { isLocalEngineUrl, providerEngineUrl } from './engine-urls';
import { recountsWithPinnedTokenizer } from './seller-offer';

export const OPENAI_READINESS = {
  warmup: {
    prompt: OPENAI_LOCAL_READINESS.prompt,
    maxTokens: OPENAI_LOCAL_READINESS.maxTokens,
  },
  residencyMs: OPENAI_LOCAL_READINESS.residencyMs,
  localResources: true,
} as const satisfies EngineReadinessPolicy;

function refuse(offer: SellerEngineOffer) {
  if (
    !providerEngineUrl(offer.engine.url) ||
    offer.engine.contextTokens === undefined
  )
    return NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED;
  if (
    offer.reasoning.length !== 1 ||
    offer.reasoning[0] !== REASONING_LEVELS.OFF
  )
    return NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED;
  return undefined;
}

export const OPENAI_ENGINE_FACTORY: EngineFactory = {
  refuse,
  create: (offer, { fetch, environment }) => {
    const url = providerEngineUrl(offer.engine.url);
    const { contextTokens, apiKeyEnv, upstreamModel } = offer.engine;
    if (!url || contextTokens === undefined)
      throw new Error('OpenAI offer was not checked before creation.');
    const recounted = recountsWithPinnedTokenizer(offer.model);
    const apiKey = apiKeyEnv ? environment[apiKeyEnv] : undefined;
    return {
      engine: createOpenAiEngine(
        {
          base: offer.engine.url,
          model: upstreamModel ?? offer.model.id,
          contextTokens,
          recountable: recounted,
          ...(apiKey ? { apiKey } : {}),
        },
        fetch,
      ),
      selection: { modelId: offer.model.id, variant: null, quantization: null },
      metering: recounted
        ? {
            mode: CONTROL_METERING_MODES.RECOUNTED,
            tokenizer: () => modelTokenizer(environment),
          }
        : { mode: CONTROL_METERING_MODES.DECLARED },
      readiness: isLocalEngineUrl(url) ? OPENAI_READINESS : REMOTE_READINESS,
    };
  },
};
