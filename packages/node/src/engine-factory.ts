// The contract every seller engine plugin implements: a pure offer check for settings and doctor, and a
// factory that builds the engine with its listed selection, metering and readiness policy without I/O.
import type { HomeEnvironment } from '@gyblos/config';
import type {
  CONTROL_METERING_MODES,
  ReasoningLevel,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import type { ChatTokenizer, Engine } from '@gyblos/protocol/engine';

import type { NODE_ERROR_CODES } from './constants';
import type { OfferEngine, OfferModel } from './node-config';

// One [[offers]] entry as an engine sees it; index is its position in gyblos.toml.
export interface SellerEngineOffer {
  index: number;
  model: OfferModel;
  engine: OfferEngine;
  reasoning: readonly ReasoningLevel[];
}

export type EngineOfferRefusal =
  | typeof NODE_ERROR_CODES.SELLER_OFFER_MODEL_UNSUPPORTED
  | typeof NODE_ERROR_CODES.SELLER_OFFER_ENGINE_UNSUPPORTED
  | typeof NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED
  | typeof NODE_ERROR_CODES.SELLER_OFFER_API_KEY_MISSING;

// How delivered tokens are counted: recounted with the model's public tokenizer, or declared by the
// engine's provider when no public tokenizer is pinned for the model.
export type OfferMetering =
  | {
      mode: typeof CONTROL_METERING_MODES.RECOUNTED;
      tokenizer: () => Promise<ChatTokenizer>;
    }
  | { mode: typeof CONTROL_METERING_MODES.DECLARED };

// What gates advertisement. An engine on this machine runs a private warmup, checks this machine's
// memory headroom and stays resident for residencyMs; an engine the seller pays per call is ready once
// it describes its model, so readiness never spends the seller's credit.
export type EngineReadinessPolicy =
  | {
      warmup: { prompt: string; maxTokens: number };
      residencyMs: number;
      localResources: boolean;
    }
  | { warmup: null; localResources: false };

// The policy the remote engine plugins (openai, anthropic) give an engine outside this machine.
export const REMOTE_READINESS = {
  warmup: null,
  localResources: false,
} as const satisfies EngineReadinessPolicy;

export interface PreparedEngine {
  engine: Engine;
  selection: ModelSelection;
  metering: OfferMetering;
  readiness: EngineReadinessPolicy;
}

// The engine's only network path and the environment it may resolve its own settings from.
export interface EngineDependencies {
  fetch: typeof fetch;
  environment: HomeEnvironment;
}

export interface EngineFactory {
  // Pure; settings and doctor use it before anything starts.
  refuse(offer: SellerEngineOffer): EngineOfferRefusal | undefined;
  // No I/O until the engine is used.
  create(
    offer: SellerEngineOffer,
    dependencies: EngineDependencies,
  ): PreparedEngine;
}
