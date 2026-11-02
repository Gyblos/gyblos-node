// Buffered OpenAI-compatible agent turns through the pinned local Ollama model.
// This adapter knows no payment state and never follows a redirect.
import { ROUTES, TIMEOUTS } from '@gyblos/config';
import {
  engineFailure,
  FrameFailure,
  statusFailure,
} from '@gyblos/core/engine-failures';
import { boundedText } from '@gyblos/core/engine-http';
import { isJsonFields, jsonFields } from '@gyblos/core/engine-provider';
import { AGENT_CHAT } from '@gyblos/protocol/constants';

import { MODEL, MODEL_LIMITS } from './constants';
import { localOllamaUrl } from './index';

export function createOllamaAgent(
  base: string,
  fetchImpl: typeof fetch = fetch,
) {
  const origin = localOllamaUrl(base);
  return {
    model: MODEL.name,
    async generate(input: unknown, caller?: AbortSignal): Promise<unknown> {
      if (
        !isJsonFields(input) ||
        input.model !== MODEL.name ||
        !Array.isArray(input.messages) ||
        typeof input.max_tokens !== 'number' ||
        !Number.isSafeInteger(input.max_tokens) ||
        input.max_tokens < 1 ||
        input.max_tokens > MODEL_LIMITS.adapterMaxOutputTokens
      )
        throw new Error('Unsupported agent request.');
      caller?.throwIfAborted();
      const deadline = AbortSignal.timeout(TIMEOUTS.generation);
      const attempt = { caller, deadline, fragments: 0 };
      const signal = AbortSignal.any([deadline, ...(caller ? [caller] : [])]);
      try {
        const response = await fetchImpl(new URL(ROUTES.inference, origin), {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, stream: false }),
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw statusFailure(response.status);
        }
        const result = jsonFields(
          await boundedText(response, MODEL_LIMITS.maxFrameCharacters),
        );
        if (
          result.object !== AGENT_CHAT.COMPLETION ||
          result.model !== MODEL.name ||
          !Array.isArray(result.choices) ||
          result.choices.length !== 1 ||
          !isJsonFields(result.usage)
        )
          throw new FrameFailure();
        return result;
      } catch (error) {
        throw engineFailure(error, attempt);
      }
    },
  };
}
