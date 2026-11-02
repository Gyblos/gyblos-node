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
import { ENGINE_ERROR_CODES } from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';

import { ollamaAgentRequest, ollamaAgentResponse } from './agent-wire';
import { AGENT_MODEL_LIMITS, MODEL, MODEL_LIMITS } from './constants';
import { localOllamaUrl } from './index';

function supportedVersion(value: unknown) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) return false;
  const version = value.split('.').map(Number);
  for (const [
    index,
    minimum,
  ] of AGENT_MODEL_LIMITS.minimumOllamaVersion.entries()) {
    const part = version[index];
    if (part === undefined || !Number.isSafeInteger(part)) return false;
    if (part !== minimum) return part > minimum;
  }
  return true;
}

function agentDescription(origin: URL, model: string, fetchImpl: typeof fetch) {
  let pinnedDigest: string | undefined;
  return async function describe() {
    const deadline = AbortSignal.timeout(TIMEOUTS.events);
    const attempt = { deadline, fragments: 0 };
    try {
      const versionResponse = await fetchImpl(
        new URL(ROUTES.ollamaVersion, origin),
        {
          redirect: 'error',
          signal: deadline,
        },
      );
      if (!versionResponse.ok) {
        await versionResponse.body?.cancel().catch(() => {});
        throw statusFailure(versionResponse.status);
      }
      const version = jsonFields(
        await boundedText(versionResponse, MODEL_LIMITS.maxFrameCharacters),
      );
      if (!supportedVersion(version.version))
        throw new EngineError(ENGINE_ERROR_CODES.UNAVAILABLE);
      const response = await fetchImpl(new URL(ROUTES.ollamaTags, origin), {
        redirect: 'error',
        signal: deadline,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw statusFailure(response.status);
      }
      const catalog = jsonFields(
        await boundedText(response, MODEL_LIMITS.maxFrameCharacters),
      );
      if (!Array.isArray(catalog.models)) throw new FrameFailure();
      const entry = catalog.models.find(
        (item) => isJsonFields(item) && item.name === model,
      );
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
  };
}

export function createOllamaAgent(
  base: string,
  fetchImpl: typeof fetch = fetch,
  options: { model?: string } = {},
) {
  const origin = localOllamaUrl(base);
  const model = options.model ?? MODEL.name;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) ||
    /(?:[:-])cloud$/i.test(model)
  )
    throw new Error('Invalid local agent model.');
  const describe = agentDescription(origin, model, fetchImpl);
  return {
    model,
    describe,
    validate(input: unknown): void {
      ollamaAgentRequest(input, model);
    },
    async generate(input: unknown, caller?: AbortSignal): Promise<unknown> {
      const request = ollamaAgentRequest(input, model);
      caller?.throwIfAborted();
      const deadline = AbortSignal.timeout(TIMEOUTS.generation);
      const attempt = { caller, deadline, fragments: 0 };
      const signal = AbortSignal.any([deadline, ...(caller ? [caller] : [])]);
      try {
        const response = await fetchImpl(new URL(ROUTES.ollamaChat, origin), {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw statusFailure(response.status);
        }
        const result = jsonFields(
          await boundedText(response, MODEL_LIMITS.maxFrameCharacters),
        );
        return ollamaAgentResponse(result, model, input);
      } catch (error) {
        throw engineFailure(error, attempt);
      }
    },
  };
}
