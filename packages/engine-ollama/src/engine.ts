// Adapts the Ollama client to the protocol Engine port: one user message, digest identity, recountable usage.
import type { Engine, EngineInput } from '@gyblos/protocol/engine';

import { GENERATION, MODEL } from './constants.js';
import { createOllama } from './index.js';

function userPrompt(input: EngineInput) {
  if (input.prompt !== undefined) return input.prompt;
  if (
    input.messages.length !== 1 ||
    input.messages[0]?.role !== 'user' ||
    typeof input.messages[0].content !== 'string'
  )
    throw new Error('Only one user message without tools is supported.');
  return input.messages[0].content;
}

export function createOllamaEngine(
  base: string,
  fetchImpl: typeof fetch = fetch,
): Engine {
  const adapter = createOllama(base, fetchImpl);
  return {
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: true,
      modelIdentity: 'digest',
    }),
    async describe() {
      await adapter.assertModel();
      return {
        name: MODEL.name,
        digest: MODEL.digest,
        contextTokens: GENERATION.numCtx,
      };
    },
    async generate(input) {
      const result = await adapter.generate({
        ...input,
        prompt: userPrompt(input),
      });
      return {
        text: result.text,
        finishReason: result.doneReason,
        usage: {
          inputTokens: result.usage.prompt_eval_count,
          outputTokens: result.usage.eval_count,
          totalDurationNs: result.usage.total_duration,
          loadDurationNs: result.usage.load_duration,
          inputDurationNs: result.usage.prompt_eval_duration,
          outputDurationNs: result.usage.eval_duration,
        },
      };
    },
  };
}
