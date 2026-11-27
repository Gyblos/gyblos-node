// Wraps a synthetic or explicitly selected local engine with labelled busy/failure injection.
// Never records prompts, responses or engine errors; no payments, RPC or automatic model downloads.
import { setTimeout as delay } from 'node:timers/promises';

import { DIAGNOSTICS } from '@gyblos/config';
import { GENERATION, MODEL } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import {
  ENGINE_DONE_REASONS,
  MODEL_IDENTITIES,
} from '@gyblos/protocol/constants';
import type { Engine } from '@gyblos/protocol/engine';
import { memorySnapshot, type MemorySnapshot } from '@gyblos/runtime/memory';

import { GATE_HOSTS } from '../constants';
import {
  ACCEPTANCE,
  ACCEPTANCE_CODES,
  ACCEPTANCE_MODES,
  type AcceptanceMode,
} from './constants';
import { AcceptanceError } from './errors';

export interface EnginePace {
  firstTokenMs: number;
  tokenMs: number;
  tokens: number;
}
const INSTANT: EnginePace = { firstTokenMs: 0, tokenMs: 0, tokens: 0 };

async function pacedText(
  input: Parameters<Engine['generate']>[0],
  pace: EnginePace,
) {
  for (let token = 0; token < pace.tokens; token++) {
    await delay(token ? pace.tokenMs : pace.firstTokenMs, undefined, {
      signal: input.signal,
    });
    await input.onText?.(' t');
    input.signal?.throwIfAborted();
  }
}
function syntheticEngine(pace: EnginePace = INSTANT): Engine {
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
    generate: async (input) => {
      if (pace.tokens) await pacedText(input, pace);
      else {
        await input.onText?.('syn');
        input.signal?.throwIfAborted();
        await input.onText?.('thetic');
        input.signal?.throwIfAborted();
      }
      return {
        text: pace.tokens ? ' t'.repeat(pace.tokens) : 'synthetic',
        finishReason: ENGINE_DONE_REASONS.STOP,
        usage: {
          inputTokens: 1,
          outputTokens: Math.max(1, pace.tokens),
          totalDurationNs: 1,
          loadDurationNs: 0,
          inputDurationNs: 0,
          outputDurationNs: 0,
        },
      };
    },
  };
}
export function createAcceptanceEngine(
  mode: AcceptanceMode,
  pace?: EnginePace,
) {
  const source =
    mode === ACCEPTANCE_MODES.OLLAMA
      ? createOllamaEngine(GATE_HOSTS.ollama)
      : syntheticEngine(pace);
  let failed = false;
  let generations = 0;
  let attempts = 0;
  let cancellations = 0;
  let heldText: Promise<void> | undefined;
  let releaseText = () => {};
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
      try {
        return await source.generate({
          ...input,
          onText: input.onText
            ? async (text) => {
                await input.onText!(text);
                const held = heldText;
                heldText = undefined;
                if (held) await holdText(held, input.signal);
              }
            : undefined,
        });
      } catch (error) {
        if (input.signal?.aborted) cancellations++;
        throw error;
      }
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
    cancellations: () => cancellations,
    holdAfterText() {
      heldText = new Promise<void>((resolve) => {
        releaseText = resolve;
      });
      return () => releaseText();
    },
    fail: (value: boolean) => {
      failed = value;
    },
    holdNext() {
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    release: () => {
      release();
      releaseText();
    },
  };
}
export type AcceptanceEngine = ReturnType<typeof createAcceptanceEngine>;

async function holdText(held: Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let abort = () => {};
  try {
    await Promise.race([
      held,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
