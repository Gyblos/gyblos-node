// Adapts the Ollama client to the protocol Engine port: a conversation, digest identity, recountable usage.
import type { Engine } from '@gyblos/protocol/engine';

import { MODEL } from './constants';
import { createOllama, type OllamaOptions } from './index';

export function createOllamaEngine(
  base: string,
  fetchImpl: typeof fetch = fetch,
  options: OllamaOptions = {},
): Engine {
  const adapter = createOllama(base, fetchImpl, options);
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
        contextTokens: adapter.contextTokens,
      };
    },
    async generate(input) {
      const result = await adapter.generate(input);
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
