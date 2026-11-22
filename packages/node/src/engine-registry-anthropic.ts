// The Anthropic engine plugin: serves any model through the Messages API at its root URL (https anywhere,
// or a literal loopback proxy), with an API key and reasoning off. Claude models have no public
// tokenizer, so usage is declared by the provider; a catalog model with the pinned tokenizer (the Qwen3
// family) is recounted, as with any engine. Every Anthropic-compatible URL is treated as paid per
// call: readiness only describes the model, never generating. The key is read from the variable the
// offer names and reaches only the engine.
import { ANTHROPIC_VERSION_SEGMENT } from '@gyblos/engine-anthropic/constants';
import { createAnthropicEngine } from '@gyblos/engine-anthropic/engine';
import {
  CONTROL_METERING_MODES,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';

import { modelTokenizer } from './artifacts';
import { NODE_ERROR_CODES } from './constants';
import {
  REMOTE_READINESS,
  upstreamModelName,
  type EngineFactory,
  type SellerEngineOffer,
} from './engine-factory';
import { providerEngineUrl } from './engine-urls';
import { recountsWithPinnedTokenizer } from './seller-offer';

function engineUrl(offer: SellerEngineOffer) {
  const url = providerEngineUrl(offer.engine.url);
  return url && !ANTHROPIC_VERSION_SEGMENT.test(url.pathname) ? url : undefined;
}

function refuse(offer: SellerEngineOffer) {
  // The model names one path segment of the model check; a dot-only name would climb out of it.
  if (/^\.+$/.test(upstreamModelName(offer)))
    return NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED;
  if (!engineUrl(offer) || offer.engine.contextTokens === undefined)
    return NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED;
  if (offer.engine.apiKeyEnv === undefined)
    return NODE_ERROR_CODES.SELLER_OFFER_API_KEY_MISSING;
  if (
    offer.reasoning.length !== 1 ||
    offer.reasoning[0] !== REASONING_LEVELS.OFF
  )
    return NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED;
  return undefined;
}

export const ANTHROPIC_ENGINE_FACTORY: EngineFactory = {
  refuse,
  create: (offer, { fetch, environment }) => {
    const { contextTokens, apiKeyEnv } = offer.engine;
    const apiKey = apiKeyEnv ? environment[apiKeyEnv] : undefined;
    if (!engineUrl(offer) || contextTokens === undefined || !apiKey)
      throw new Error('Anthropic offer was not checked before creation.');
    const recounted = recountsWithPinnedTokenizer(offer.model);
    return {
      engine: createAnthropicEngine(
        {
          base: offer.engine.url,
          model: upstreamModelName(offer),
          contextTokens,
          apiKey,
          recountable: recounted,
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
      readiness: REMOTE_READINESS,
    };
  },
};
