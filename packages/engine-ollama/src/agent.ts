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
import { AGENT_CHAT, ENGINE_ERROR_CODES } from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';

import { MODEL, MODEL_LIMITS } from './constants';
import { localOllamaUrl } from './index';

export function createOllamaAgent(
  base: string,
  fetchImpl: typeof fetch = fetch,
  options: { model?: string } = {},
) {
  const origin = localOllamaUrl(base);
  const model = options.model ?? MODEL.name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) || model.endsWith(':cloud'))
    throw new Error('Invalid local agent model.');
  let pinnedDigest: string | undefined;
  function validate(input: unknown): void {
    if (
      !isJsonFields(input) ||
      input.model !== model ||
      !Array.isArray(input.messages) ||
      typeof input.max_tokens !== 'number' ||
      !Number.isSafeInteger(input.max_tokens) ||
      input.max_tokens < 1 ||
      input.max_tokens > MODEL_LIMITS.adapterMaxOutputTokens
    )
      throw new Error('Unsupported agent request.');
  }
  return {
    model,
    validate,
    async describe() {
      const deadline = AbortSignal.timeout(TIMEOUTS.events);
      const attempt = { deadline, fragments: 0 };
      try {
        const response = await fetchImpl(new URL(ROUTES.ollamaTags, origin), {
          redirect: 'error',
          signal: deadline,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw statusFailure(response.status);
        }
        const catalog = jsonFields(await boundedText(response, MODEL_LIMITS.maxFrameCharacters));
        if (!Array.isArray(catalog.models)) throw new FrameFailure();
        const entry = catalog.models.find((item) => isJsonFields(item) && item.name === model);
        if (
          !isJsonFields(entry) ||
          typeof entry.digest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.digest) ||
          entry.remote_host ||
          entry.remote_model ||
          !Array.isArray(entry.capabilities) ||
          !entry.capabilities.includes('tools') ||
          (pinnedDigest && entry.digest !== pinnedDigest)
        )
          throw new EngineError(ENGINE_ERROR_CODES.UNAVAILABLE);
        pinnedDigest = entry.digest;
        return { name: model, digest: entry.digest };
      } catch (error) {
        throw engineFailure(error, attempt);
      }
    },
    async generate(input: unknown, caller?: AbortSignal): Promise<unknown> {
      validate(input);
      if (!isJsonFields(input)) throw new Error('Unsupported agent request.');
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
          result.model !== model ||
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
