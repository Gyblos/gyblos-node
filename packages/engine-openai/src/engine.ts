// OpenAI-compatible chat completions (vLLM, LM Studio, llama.cpp, OpenRouter, OpenAI) as the protocol
// Engine port: one user message to the configured upstream model, streamed with the provider's usage.
// Identity is the model name only. The optional API key travels only in the Authorization header of
// requests to the offer's base URL, which never follow redirects. Failures follow the Engine port
// contract in @gyblos/protocol/engine; provider bodies, headers and text never reach them.
import {
  engineFailure,
  FrameFailure,
  statusFailure,
  type EngineAttempt,
} from '@gyblos/core/engine-failures';
import { boundedText, serverSentData } from '@gyblos/core/engine-http';
import {
  deliverText,
  doneReasonFrom,
  elapsedNanoseconds,
  errorFields,
  generationAttempt,
  isJsonFields,
  jsonFields,
  providerCount,
  providerRoute,
  visibleFragment,
  type JsonFields,
} from '@gyblos/core/engine-provider';
import { finishedToolCalls } from '@gyblos/core/engine-tools';
import {
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
  MODEL_IDENTITIES,
  type EngineDoneReason,
} from '@gyblos/protocol/constants';
import {
  EngineError,
  type Engine,
  type EngineInput,
  type EngineResult,
} from '@gyblos/protocol/engine';
import { TOOL_CALLS_DONE } from '@gyblos/protocol/tools';

import {
  OPENAI_FINISH_REASONS,
  OPENAI_HOST,
  OPENAI_LIMITS,
  OPENAI_QUOTA_CODE,
  OPENAI_ROUTES,
  OPENAI_STREAM_END,
  OPENAI_TIMEOUTS,
} from './constants';
import { applyToolDeltas, openAiMessages, openAiTools } from './tools';

export interface OpenAiEngineSettings {
  // The API base, ending in its version (https://api.example.com/v1).
  base: string;
  // The model name the provider expects.
  model: string;
  // The model's context size from gyblos.toml; the API does not report it.
  contextTokens: number;
  apiKey?: string;
  // True when the seller recounts this model's output with its pinned public tokenizer.
  recountable: boolean;
}

export interface OpenAiOptions {
  generationTimeoutMs?: number;
  describeTimeoutMs?: number;
}

const HTTP_TOO_MANY_REQUESTS = 429;

// OpenAI's own API and its regional hosts (eu.api.openai.com).
const isOpenAi = (base: string) => {
  const host = new URL(base).hostname.replace(/\.$/, '');
  return host === OPENAI_HOST || host.endsWith(`.${OPENAI_HOST}`);
};

function authorization(settings: OpenAiEngineSettings): Record<string, string> {
  return settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {};
}

// Compatible servers name the same two endings differently.
const FINISH_REASONS: Readonly<Record<string, EngineDoneReason>> =
  OPENAI_FINISH_REASONS;
// The endings that mean the model called tools (function_call is the legacy name).
const TOOL_FINISHES = ['tool_calls', 'function_call'];

// A refused request: an account without credit is quota exhaustion, any other status maps as usual.
// OpenAI-compatible servers report it only with 429, so only that body is read, for its error code,
// within a bound, and never kept; any other body is discarded unread.
async function refusal(response: Response) {
  if (response.status === HTTP_TOO_MANY_REQUESTS) {
    const error = await errorFields(response, OPENAI_LIMITS.errorBytes);
    if (error?.code === OPENAI_QUOTA_CODE || error?.type === OPENAI_QUOTA_CODE)
      return new EngineError(ENGINE_ERROR_CODES.QUOTA_EXHAUSTED);
  } else await response.body?.cancel().catch(() => {});
  return statusFailure(response.status);
}

async function describeModel(
  settings: OpenAiEngineSettings,
  fetchImpl: typeof fetch,
  timeoutMs: number,
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const attempt: EngineAttempt = { deadline, fragments: 0 };
  try {
    const response = await fetchImpl(
      providerRoute(settings.base, OPENAI_ROUTES.models),
      {
        redirect: 'error',
        headers: authorization(settings),
        signal: deadline,
      },
    );
    if (!response.ok) throw await refusal(response);
    const data = jsonFields(
      await boundedText(response, OPENAI_LIMITS.modelsBytes),
    ).data;
    if (
      !Array.isArray(data) ||
      !data.some((item) => isJsonFields(item) && item.id === settings.model)
    )
      throw new EngineError(ENGINE_ERROR_CODES.UNAVAILABLE);
    return { name: settings.model, contextTokens: settings.contextTokens };
  } catch (error) {
    throw engineFailure(error, attempt);
  }
}

// What the stream has said so far; a completion needs a finish reason and the provider's usage.
interface Completion {
  text: string;
  finish?: EngineDoneReason | typeof TOOL_CALLS_DONE;
  usage?: { inputTokens: number; outputTokens: number };
  calls: { id: string; name: string; arguments: string }[];
}

// Applies one streamed event; returns the visible text it carried. Hidden reasoning is never delivered.
function applyEvent(event: JsonFields, completion: Completion) {
  if (event.error !== undefined) throw new FrameFailure(true);
  if (isJsonFields(event.usage))
    completion.usage = {
      inputTokens: providerCount(event.usage.prompt_tokens),
      outputTokens: providerCount(event.usage.completion_tokens),
    };
  const { choices } = event;
  // Some servers send the final usage alone, without choices.
  if (choices === undefined && isJsonFields(event.usage)) return '';
  if (!Array.isArray(choices) || choices.length > 1) throw new FrameFailure();
  const choice: unknown = choices[0];
  if (choice === undefined) return '';
  if (!isJsonFields(choice)) throw new FrameFailure();
  const delta = isJsonFields(choice.delta) ? choice.delta : {};
  const content = delta.content;
  const text =
    content === undefined || content === null
      ? ''
      : visibleFragment(content, !!completion.finish);
  applyToolDeltas(delta.tool_calls, completion.calls);
  if (choice.finish_reason !== undefined && choice.finish_reason !== null)
    completion.finish = TOOL_FINISHES.includes(String(choice.finish_reason))
      ? TOOL_CALLS_DONE
      : doneReasonFrom(FINISH_REASONS, choice.finish_reason);
  return text;
}

async function readCompletion(
  body: ReadableStream<Uint8Array>,
  input: EngineInput,
  signal: AbortSignal,
  attempt: EngineAttempt,
): Promise<Required<Completion>> {
  const completion: Completion = { text: '', calls: [] };
  for await (const data of serverSentData(body, OPENAI_LIMITS.stream)) {
    signal.throwIfAborted();
    if (data === OPENAI_STREAM_END) break;
    const event = jsonFields(data);
    const fragment = applyEvent(event, completion);
    if (fragment)
      await deliverText(
        fragment,
        completion,
        OPENAI_LIMITS.outputCharacters,
        input,
        signal,
        attempt,
      );
    // Finished, then counted by this event: a proxy that keeps the stream open cannot hold a complete
    // answer, and an earlier running count is never taken for the final one.
    if (completion.finish && isJsonFields(event.usage)) break;
  }
  const { text, finish, usage, calls } = completion;
  if (!finish || (finish === TOOL_CALLS_DONE) !== calls.length > 0)
    throw new FrameFailure();
  // Declared usage is the provider's or nothing: a completion without it is not served.
  // So is a completion with neither visible text nor calls: its budget went to hidden reasoning.
  if (!usage || (!text && !calls.length))
    throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
  return { text, finish, usage, calls };
}

async function generate(
  settings: OpenAiEngineSettings,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  input: EngineInput,
): Promise<EngineResult> {
  const { messages, attempt, signal, started } = generationAttempt(input, {
    maxOutputTokens: settings.contextTokens,
    timeoutMs,
  });
  try {
    const response = await fetchImpl(
      providerRoute(settings.base, OPENAI_ROUTES.chat),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...authorization(settings),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: settings.model,
          messages: openAiMessages(messages),
          ...openAiTools(input.tools, input.toolChoice),
          // OpenAI's own API takes the newer name, which its reasoning models require; compatible
          // servers take max_tokens.
          [isOpenAi(settings.base) ? 'max_completion_tokens' : 'max_tokens']:
            input.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      },
    );
    if (!response.ok || !response.body) throw await refusal(response);
    const { text, finish, usage, calls } = await readCompletion(
      response.body,
      input,
      signal,
      attempt,
    );
    return {
      text,
      finishReason: finish,
      ...(calls.length
        ? { toolCalls: finishedToolCalls(calls, input.tools) }
        : {}),
      usage: {
        ...usage,
        totalDurationNs: elapsedNanoseconds(started),
        loadDurationNs: 0,
        inputDurationNs: 0,
        outputDurationNs: 0,
      },
    };
  } catch (error) {
    throw engineFailure(error, attempt);
  }
}

export function createOpenAiEngine(
  settings: OpenAiEngineSettings,
  fetchImpl: typeof fetch = fetch,
  options: OpenAiOptions = {},
): Engine {
  const generationTimeoutMs =
    options.generationTimeoutMs ?? OPENAI_TIMEOUTS.generationMs;
  const describeTimeoutMs =
    options.describeTimeoutMs ?? OPENAI_TIMEOUTS.describeMs;
  return {
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: settings.recountable,
      modelIdentity: MODEL_IDENTITIES.NAME_ONLY,
    }),
    describe: () => describeModel(settings, fetchImpl, describeTimeoutMs),
    // Chat completions carry tools natively; whether the model uses them well is the seller's choice.
    supportsTools: () => true,
    generate: (input) =>
      generate(settings, fetchImpl, generationTimeoutMs, input),
  };
}
