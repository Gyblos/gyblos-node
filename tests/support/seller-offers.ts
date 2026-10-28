// Synthetic live seller offers for offer-set, catalog and routing tests: a distinct catalog model per
// gyblos.toml index, mutable readiness and counted observation lifecycle. No engines or network.
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import { recountedMeter } from '@gyblos/node/free-meter';
import type { LiveSellerOffer } from '@gyblos/node/seller-offer-set';
import {
  CONTROL_METERING_MODES,
  MODEL_IDENTITIES,
  MODEL_IDS,
  OFFER_PRICING_KINDS,
  REASONING_LEVELS,
} from '@gyblos/protocol/constants';
import type { Engine } from '@gyblos/protocol/engine';

const MODELS = Object.values(MODEL_IDS);

export function fakeLiveOffer(
  index: number,
  now: number,
  initial: Partial<QuoteReadiness> = {},
  modelId: string = MODELS[index]!,
) {
  let state: QuoteReadiness = {
    generation: 1,
    busy: false,
    observedAt: now,
    validUntil: now + 60_000,
    ...initial,
  };
  let started = 0;
  let stopped = 0;
  const engine: Engine = {
    describe: async () => live.model,
    capabilities: () => live.capabilities,
    generate: async () => ({
      text: 'answer',
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalDurationNs: 0,
        loadDurationNs: 0,
        inputDurationNs: 0,
        outputDurationNs: 0,
      },
      finishReason: 'stop',
    }),
  };
  const live: LiveSellerOffer = {
    index,
    selection: { modelId, variant: null, quantization: 'Q4_K_M' },
    offer: {
      modelId,
      reasoning: [REASONING_LEVELS.OFF],
      kind: OFFER_PRICING_KINDS.FREE,
      caps: { dailyTokenCap: 1000, perBuyerCap: 1000 },
    },
    model: {
      name: `internal/${modelId}`,
      digest: `sha256:${index}`,
      contextTokens: 2048,
    },
    capabilities: {
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: MODEL_IDENTITIES.DIGEST,
    },
    meteringMode: CONTROL_METERING_MODES.RECOUNTED,
    readiness: () => ({ ...state }),
    engine,
    meter: recountedMeter({
      input: (text) => text.length,
      count: (text) => text.length,
    }),
    observation: {
      start: () => {
        started++;
      },
      stop: async () => {
        stopped++;
      },
    },
  };
  return {
    live,
    set(value: Partial<QuoteReadiness>) {
      state = { ...state, ...value };
    },
    started: () => started,
    stopped: () => stopped,
  };
}
