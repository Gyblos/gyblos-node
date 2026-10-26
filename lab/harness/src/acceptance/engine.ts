// Wraps a synthetic or explicitly selected local engine with labelled busy/failure injection.
// Never records prompts, responses or engine errors; no payments, RPC or automatic model downloads.
import { DIAGNOSTICS, HOSTS } from '@gyblos/config';
import { GENERATION, MODEL } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import {
  ENGINE_DONE_REASONS,
  MODEL_IDENTITIES,
} from '@gyblos/protocol/constants';
import type { Engine } from '@gyblos/protocol/engine';
import { memorySnapshot, type MemorySnapshot } from '@gyblos/runtime/memory';

import {
  ACCEPTANCE,
  ACCEPTANCE_CODES,
  ACCEPTANCE_MODES,
  type AcceptanceMode,
} from './constants.js';
import { AcceptanceError } from './errors.js';

function syntheticEngine(): Engine {
  return {
    describe: async () => ({
      name: MODEL.name,
      digest: MODEL.digest,
      contextTokens: GENERATION.numCtx,
    }),
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: MODEL_IDENTITIES.DIGEST,
    }),
    generate: async () => ({
      text: 'synthetic',
      finishReason: ENGINE_DONE_REASONS.STOP,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        totalDurationNs: 1,
        loadDurationNs: 0,
        inputDurationNs: 0,
        outputDurationNs: 0,
      },
    }),
  };
}
export function createAcceptanceEngine(mode: AcceptanceMode) {
  const source =
    mode === ACCEPTANCE_MODES.OLLAMA
      ? createOllamaEngine(HOSTS.ollama)
      : syntheticEngine();
  let failed = false;
  let generations = 0;
  let attempts = 0;
  let blocked: Promise<void> | undefined;
  let release = () => {};
  const engine: Engine = {
    capabilities: () => source.capabilities(),
    describe: async () => {
      if (failed)
        throw new AcceptanceError(ACCEPTANCE_CODES.ENGINE_UNAVAILABLE);
      return source.describe();
    },
    generate: async (input) => {
      attempts++;
      const held = blocked;
      blocked = undefined;
      if (held) await held;
      input.signal?.throwIfAborted();
      if (failed)
        throw new AcceptanceError(ACCEPTANCE_CODES.ENGINE_UNAVAILABLE);
      generations++;
      return source.generate(input);
    },
  };
  const snapshot = (): Promise<MemorySnapshot> =>
    mode === ACCEPTANCE_MODES.OLLAMA
      ? memorySnapshot()
      : Promise.resolve({
          source: DIAGNOSTICS.memorySources.fallback,
          vmAvailableBytes: ACCEPTANCE.syntheticMemoryBytes,
          cgroup: null,
        });
  return {
    engine,
    snapshot,
    generations: () => generations,
    attempts: () => attempts,
    fail: (value: boolean) => {
      failed = value;
    },
    holdNext() {
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    release: () => release(),
  };
}
export type AcceptanceEngine = ReturnType<typeof createAcceptanceEngine>;
