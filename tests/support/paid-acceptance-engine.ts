// Deterministic recounted engine injected only by verification; never loads artifacts or contacts a provider.
import {
  REMOTE_READINESS,
  type PreparedEngine,
} from '@gyblos/node/engine-factory';
import {
  CONTROL_METERING_MODES,
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
  MODEL_IDS,
} from '@gyblos/protocol/constants';
import { EngineError, type RecountTokenizer } from '@gyblos/protocol/engine';

import { PAID_ACCEPTANCE } from './paid-acceptance-constants';

export const paidAcceptanceMeter: RecountTokenizer = {
  input: () => PAID_ACCEPTANCE.inputTokens,
  count: (text) => [...text].length,
};
export function paidAcceptanceEngine() {
  let attempts = 0;
  let cancellations = 0;
  let failure = false;
  let held = false;
  let release = () => {};
  const create = (): PreparedEngine => ({
    selection: {
      modelId: MODEL_IDS.QWEN3_0_6B,
      variant: null,
      quantization: MODEL.quantization,
    },
    readiness: REMOTE_READINESS,
    metering: {
      mode: CONTROL_METERING_MODES.RECOUNTED,
      tokenizer: async () => paidAcceptanceMeter,
    },
    engine: {
      capabilities: () => ({
        reportsUsage: true,
        logprobs: false,
        cancellable: true,
        recountable: true,
        modelIdentity: 'name-only',
      }),
      describe: async () => ({
        name: 'synthetic-paid-model',
        contextTokens: 512,
      }),
      async generate(input) {
        attempts++;
        if (failure) throw new EngineError(ENGINE_ERROR_CODES.UNAVAILABLE);
        await input.onText?.(PAID_ACCEPTANCE.text);
        if (held) {
          held = false;
          await new Promise<void>((resolve, reject) => {
            const stop = () => {
              cancellations++;
              reject(input.signal?.reason);
            };
            release = () => {
              input.signal?.removeEventListener('abort', stop);
              resolve();
            };
            input.signal?.addEventListener('abort', stop, { once: true });
            if (input.signal?.aborted) stop();
          });
        }
        return {
          text: PAID_ACCEPTANCE.text,
          usage: {
            inputTokens: 99,
            outputTokens: 99,
            totalDurationNs: 0,
            loadDurationNs: 0,
            inputDurationNs: 0,
            outputDurationNs: 0,
          },
          finishReason: ENGINE_DONE_REASONS.STOP,
        };
      },
    },
  });
  return {
    create,
    cancellations: () => cancellations,
    attempts: () => attempts,
    fail(value: boolean) {
      failure = value;
    },
    hold() {
      held = true;
    },
    release: () => release(),
  };
}
