// The contract every seller engine plugin implements: a pure offer check for settings and doctor, and a
// factory that builds the engine with its listed selection, metering and readiness policy without I/O.
// Not yet covered: the managed Ollama process lifecycle (in seller.ts until PR 2c) and remote engines
// without local memory headroom (PR 3).
import type { HomeEnvironment } from '@gyblos/config';
import type {
  CONTROL_METERING_MODES,
  ReasoningLevel,
} from '@gyblos/protocol/constants';
import type { ModelSelection } from '@gyblos/protocol/control-types';
import type { Engine, RecountTokenizer } from '@gyblos/protocol/engine';

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
  | typeof NODE_ERROR_CODES.SELLER_OFFER_REASONING_UNSUPPORTED;

// How delivered tokens are counted. Remote engines add a provider-declared branch in PR 3; consumers
// type the mode as ControlMeteringMode so that branch only touches this file.
export interface OfferMetering {
  mode: typeof CONTROL_METERING_MODES.RECOUNTED;
  tokenizer: () => Promise<RecountTokenizer>;
}

// The private warmup that gates advertisement, and how long the warmed model stays resident.
export interface EngineReadinessPolicy {
  warmup: { prompt: string; maxTokens: number };
  residencyMs: number;
}

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
