// OpenAI-compatible chat completions (vLLM, LM Studio, llama.cpp, OpenRouter, OpenAI) as the protocol
// Engine port: one user message to the configured upstream model, streamed with the provider's usage.
// Identity is the model name only. The optional API key travels only in the Authorization header of
// requests to the offer's base URL, which never follow redirects. Failures follow the Engine port
// contract in @gyblos/protocol/engine; provider bodies, headers and text never reach them.
import {
  BoundFailure,
  callerCallback,
  engineFailure,
  FrameFailure,
  statusFailure,
  type EngineAttempt,
} from '@gyblos/core/engine-failures';
import { boundedText, serverSentData } from '@gyblos/core/engine-http';
import {
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
  MODEL_IDENTITIES,
  type EngineDoneReason,
} from '@gyblos/protocol/constants';
import {
  EngineError,
  singleUserPrompt,
  type Engine,
  type EngineInput,
  type EngineResult,
} from '@gyblos/protocol/engine';

import {
  OPENAI_FINISH_REASONS,
  OPENAI_HOST,
  OPENAI_LIMITS,
  OPENAI_QUOTA_CODE,
  OPENAI_ROUTES,
  OPENAI_STREAM_END,
  OPENAI_TIMEOUTS,
} from './constants';

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

type Fields = Record<string, unknown>;
const HTTP_TOO_MANY_REQUESTS = 429;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const isFields = (value: unknown): value is Fields =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isOpenAi = (base: string) => new URL(base).hostname === OPENAI_HOST;

function route(base: string, path: string) {
  return new URL(path, base.endsWith('/') ? base : `${base}/`);
}

function authorization(settings: OpenAiEngineSettings): Record<string, string> {
  return settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {};
}

function parseFields(text: string): Fields {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FrameFailure();
  }
  if (!isFields(value)) throw new FrameFailure();
  return value;
}

function count(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
  return value;
}

// Compatible servers name the same two endings differently; any other ending (a filter, a tool call,
// an error) is not a served completion.
const FINISH_REASONS: Readonly<Record<string, EngineDoneReason>> =
  OPENAI_FINISH_REASONS;
function doneReason(value: unknown): EngineDoneReason {
  const reason =
    typeof value === 'string' && Object.hasOwn(FINISH_REASONS, value)
      ? FINISH_REASONS[value]
      : undefined;
  if (!reason) throw new FrameFailure();
  return reason;
}

// A refused request: an account without credit is quota exhaustion, any other status maps as usual.
// The body is read only for its error code, within a bound, and never kept.
async function refusal(response: Response) {
  if (response.status === HTTP_TOO_MANY_REQUESTS) {
    const body = await boundedText(response, OPENAI_LIMITS.errorBytes).catch(
      () => '',
    );
    let error: unknown;
    try {
      error = Reflect.get(parseFields(body), 'error');
    } catch {
      error = undefined;
    }
    if (
      isFields(error) &&
      (error.code === OPENAI_QUOTA_CODE || error.type === OPENAI_QUOTA_CODE)
    )
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
      route(settings.base, OPENAI_ROUTES.models),
      {
        redirect: 'error',
        headers: authorization(settings),
        signal: deadline,
      },
    );
    if (!response.ok) throw await refusal(response);
    const data = parseFields(
      await boundedText(response, OPENAI_LIMITS.modelsBytes),
    ).data;
    if (
      !Array.isArray(data) ||
      !data.some((item) => isFields(item) && item.id === settings.model)
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
  finish?: EngineDoneReason;
  usage?: { inputTokens: number; outputTokens: number };
}

// Applies one streamed event; returns the visible text it carried. Hidden reasoning is never delivered.
function applyEvent(event: Fields, completion: Completion) {
  if (event.error !== undefined) throw new FrameFailure(true);
  if (isFields(event.usage))
    completion.usage = {
      inputTokens: count(event.usage.prompt_tokens),
      outputTokens: count(event.usage.completion_tokens),
    };
  const { choices } = event;
  // Some servers send the final usage alone, without choices.
  if (choices === undefined && completion.usage) return '';
  if (!Array.isArray(choices) || choices.length > 1) throw new FrameFailure();
  const choice: unknown = choices[0];
  if (choice === undefined) return '';
  if (!isFields(choice)) throw new FrameFailure();
  const content = isFields(choice.delta) ? choice.delta.content : undefined;
  let text = '';
  if (content !== undefined && content !== null) {
    if (
      typeof content !== 'string' ||
      /[\uD800-\uDFFF]/u.test(content) ||
      (content && completion.finish)
    )
      throw new FrameFailure();
    text = content;
  }
  if (choice.finish_reason !== undefined && choice.finish_reason !== null)
    completion.finish = doneReason(choice.finish_reason);
  return text;
}

async function deliver(
  fragment: string,
  completion: Completion,
  input: EngineInput,
  signal: AbortSignal,
  attempt: EngineAttempt,
) {
  completion.text += fragment;
  if (completion.text.length > OPENAI_LIMITS.outputCharacters)
    throw new BoundFailure();
  attempt.fragments++;
  await callerCallback(attempt, input.onFragment);
  signal.throwIfAborted();
  const onText = input.onText;
  await callerCallback(attempt, onText && (() => onText(fragment)));
  signal.throwIfAborted();
}

async function readCompletion(
  body: ReadableStream<Uint8Array>,
  input: EngineInput,
  signal: AbortSignal,
  attempt: EngineAttempt,
): Promise<Required<Completion>> {
  const completion: Completion = { text: '' };
  for await (const data of serverSentData(body, OPENAI_LIMITS.stream)) {
    signal.throwIfAborted();
    if (data === OPENAI_STREAM_END) break;
    const fragment = applyEvent(parseFields(data), completion);
    if (fragment) await deliver(fragment, completion, input, signal, attempt);
    // Finished and counted: a proxy that keeps the stream open cannot hold a complete answer.
    if (completion.finish && completion.usage) break;
  }
  const { text, finish, usage } = completion;
  if (!finish) throw new FrameFailure();
  // Declared usage is the provider's or nothing: a completion without it is not served.
  // So is a completion with no visible text: its budget went to hidden reasoning, which is not served.
  if (!usage || !text)
    throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
  return { text, finish, usage };
}

async function generate(
  settings: OpenAiEngineSettings,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  input: EngineInput,
): Promise<EngineResult> {
  if (
    !Number.isSafeInteger(input.maxTokens) ||
    input.maxTokens < 1 ||
    input.maxTokens > OPENAI_LIMITS.maxOutputTokens
  )
    throw new Error('Invalid output token limit.');
  const prompt = singleUserPrompt(input);
  input.signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  const attempt: EngineAttempt = {
    caller: input.signal,
    deadline,
    fragments: 0,
  };
  const signal = AbortSignal.any([
    deadline,
    ...(input.signal ? [input.signal] : []),
  ]);
  const started = performance.now();
  try {
    const response = await fetchImpl(route(settings.base, OPENAI_ROUTES.chat), {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...authorization(settings),
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: prompt }],
        // OpenAI's own API takes the newer name, which its reasoning models require; compatible
        // servers take max_tokens.
        [isOpenAi(settings.base) ? 'max_completion_tokens' : 'max_tokens']:
          input.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal,
    });
    if (!response.ok || !response.body) throw await refusal(response);
    const { text, finish, usage } = await readCompletion(
      response.body,
      input,
      signal,
      attempt,
    );
    return {
      text,
      finishReason: finish,
      usage: {
        ...usage,
        totalDurationNs: Math.round(
          (performance.now() - started) * NANOSECONDS_PER_MILLISECOND,
        ),
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
    generate: (input) =>
      generate(settings, fetchImpl, generationTimeoutMs, input),
  };
}
