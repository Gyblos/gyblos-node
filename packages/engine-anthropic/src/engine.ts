// The Anthropic Messages API (and compatible servers) as the protocol Engine port: one user message to
// the configured model, streamed with the provider's usage. Identity is the model name only. The API key
// travels only in the x-api-key header of requests to the offer's API root, which never follow
// redirects. Thinking is never delivered. Failures follow the Engine port contract in
// @gyblos/protocol/engine; provider bodies, headers and text never reach them.
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
import {
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

import {
  ANTHROPIC_CREDIT,
  ANTHROPIC_EVENTS,
  ANTHROPIC_HIDDEN_DELTAS,
  ANTHROPIC_INPUT_FIELDS,
  ANTHROPIC_LIMITS,
  ANTHROPIC_ROUTES,
  ANTHROPIC_STOP_REASONS,
  ANTHROPIC_TEXT_DELTA,
  ANTHROPIC_TIMEOUTS,
  ANTHROPIC_VERSION,
} from './constants';

export interface AnthropicEngineSettings {
  // The API root, without a version path (https://api.anthropic.com).
  base: string;
  // The model id or alias the provider expects.
  model: string;
  // The model's context size from gyblos.toml; the API does not report it.
  contextTokens: number;
  apiKey: string;
}

export interface AnthropicOptions {
  generationTimeoutMs?: number;
  describeTimeoutMs?: number;
}

const headers = (settings: AnthropicEngineSettings) => ({
  'x-api-key': settings.apiKey,
  'anthropic-version': ANTHROPIC_VERSION,
});

const STOP_REASONS: Readonly<Record<string, EngineDoneReason>> =
  ANTHROPIC_STOP_REASONS;
const HIDDEN_DELTAS: readonly string[] = ANTHROPIC_HIDDEN_DELTAS;

// The usual no-credit answer, read from a bounded slice of its message that is never kept.
function noCredit(error: JsonFields | undefined, status: number) {
  if (!error) return false;
  if (error.type === ANTHROPIC_CREDIT.billingType) return true;
  return (
    status === ANTHROPIC_CREDIT.invalidRequestStatus &&
    error.type === ANTHROPIC_CREDIT.invalidRequestType &&
    typeof error.message === 'string' &&
    ANTHROPIC_CREDIT.message.test(
      error.message.slice(0, ANTHROPIC_CREDIT.messageCharacters),
    )
  );
}

// A refused request: an account without credit is quota exhaustion, any other refusal maps by status.
// Unlike OpenAI-compatible servers, the API reports missing credit at more than one status, so every
// refused body is read, within a bound, only for its error type and never kept.
async function refusal(response: Response) {
  const error = await errorFields(response, ANTHROPIC_LIMITS.errorBytes);
  return noCredit(error, response.status)
    ? new EngineError(ENGINE_ERROR_CODES.QUOTA_EXHAUSTED)
    : statusFailure(response.status);
}

async function describeModel(
  settings: AnthropicEngineSettings,
  fetchImpl: typeof fetch,
  timeoutMs: number,
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const attempt: EngineAttempt = { deadline, fragments: 0 };
  try {
    const route = providerRoute(
      settings.base,
      ANTHROPIC_ROUTES.model + encodeURIComponent(settings.model),
    );
    const response = await fetchImpl(route, {
      redirect: 'error',
      headers: headers(settings),
      signal: deadline,
    });
    if (!response.ok) throw await refusal(response);
    jsonFields(await boundedText(response, ANTHROPIC_LIMITS.modelBytes));
    return { name: settings.model, contextTokens: settings.contextTokens };
  } catch (error) {
    throw engineFailure(error, attempt);
  }
}

// What the stream has said so far. Input counts may arrive at message start and be restated later;
// the output count is the cumulative one of the last message delta.
interface Completion {
  text: string;
  input: Partial<Record<(typeof ANTHROPIC_INPUT_FIELDS)[number], number>>;
  output?: number;
  finish?: EngineDoneReason;
}

function readUsage(usage: unknown, completion: Completion, output: boolean) {
  if (!isJsonFields(usage)) return;
  for (const field of ANTHROPIC_INPUT_FIELDS)
    if (usage[field] !== undefined && usage[field] !== null)
      completion.input[field] = providerCount(usage[field]);
  if (output && usage.output_tokens !== undefined)
    completion.output = providerCount(usage.output_tokens);
}

// A content delta's visible text; thinking and other hidden deltas carry none, a tool's input fails.
function deltaText(delta: unknown, completion: Completion) {
  if (!isJsonFields(delta) || typeof delta.type !== 'string')
    throw new FrameFailure();
  if (HIDDEN_DELTAS.includes(delta.type)) return '';
  if (delta.type !== ANTHROPIC_TEXT_DELTA) throw new FrameFailure();
  return visibleFragment(delta.text, !!completion.finish);
}

// Applies one streamed event and returns the visible text it carried. Events it does not know (pings,
// block boundaries, types added later) carry none.
function applyEvent(event: JsonFields, completion: Completion) {
  switch (event.type) {
    case ANTHROPIC_EVENTS.ERROR:
      throw new FrameFailure(true);
    case ANTHROPIC_EVENTS.MESSAGE_START:
      if (!isJsonFields(event.message)) throw new FrameFailure();
      readUsage(event.message.usage, completion, false);
      return '';
    case ANTHROPIC_EVENTS.BLOCK_DELTA:
      return deltaText(event.delta, completion);
    case ANTHROPIC_EVENTS.MESSAGE_DELTA: {
      const reason = isJsonFields(event.delta)
        ? event.delta.stop_reason
        : undefined;
      if (reason !== undefined && reason !== null)
        completion.finish = doneReasonFrom(STOP_REASONS, reason);
      readUsage(event.usage, completion, true);
      return '';
    }
    default:
      if (typeof event.type !== 'string') throw new FrameFailure();
      return '';
  }
}

async function readCompletion(
  body: ReadableStream<Uint8Array>,
  input: EngineInput,
  signal: AbortSignal,
  attempt: EngineAttempt,
) {
  const completion: Completion = { text: '', input: {} };
  for await (const data of serverSentData(body, ANTHROPIC_LIMITS.stream)) {
    signal.throwIfAborted();
    const event = jsonFields(data);
    if (event.type === ANTHROPIC_EVENTS.MESSAGE_STOP) break;
    const fragment = applyEvent(event, completion);
    if (fragment)
      await deliverText(
        fragment,
        completion,
        ANTHROPIC_LIMITS.outputCharacters,
        input,
        signal,
        attempt,
      );
    // Finished and counted by this event: a proxy that keeps the stream open cannot hold the answer.
    if (
      completion.finish &&
      event.type === ANTHROPIC_EVENTS.MESSAGE_DELTA &&
      isJsonFields(event.usage)
    )
      break;
  }
  const { text, finish, output } = completion;
  if (!finish) throw new FrameFailure();
  const { input_tokens: fresh } = completion.input;
  // Declared usage is the provider's or nothing, and an answer that is only thinking is not served.
  if (fresh === undefined || output === undefined || !text)
    throw new EngineError(ENGINE_ERROR_CODES.INVALID_RESPONSE);
  const inputTokens = Object.values(completion.input).reduce(
    (sum, value) => sum + value,
    0,
  );
  return { text, finish, usage: { inputTokens, outputTokens: output } };
}

async function generate(
  settings: AnthropicEngineSettings,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  input: EngineInput,
): Promise<EngineResult> {
  const { messages, attempt, signal, started } = generationAttempt(input, {
    maxOutputTokens: settings.contextTokens,
    timeoutMs,
  });
  // The Messages API takes the system message apart from the turns.
  const system =
    messages[0]?.role === 'system' ? messages[0].content : undefined;
  const turns = system === undefined ? messages : messages.slice(1);
  try {
    const response = await fetchImpl(
      providerRoute(settings.base, ANTHROPIC_ROUTES.messages),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          ...headers(settings),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        // No thinking parameter: offers list reasoning "off", and thinking is off unless asked for.
        body: JSON.stringify({
          model: settings.model,
          max_tokens: input.maxTokens,
          ...(system === undefined ? {} : { system }),
          messages: turns,
          stream: true,
        }),
        signal,
      },
    );
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

export function createAnthropicEngine(
  settings: AnthropicEngineSettings,
  fetchImpl: typeof fetch = fetch,
  options: AnthropicOptions = {},
): Engine {
  const generationTimeoutMs =
    options.generationTimeoutMs ?? ANTHROPIC_TIMEOUTS.generationMs;
  const describeTimeoutMs =
    options.describeTimeoutMs ?? ANTHROPIC_TIMEOUTS.describeMs;
  return {
    capabilities: () => ({
      reportsUsage: true,
      logprobs: false,
      cancellable: true,
      recountable: false,
      modelIdentity: MODEL_IDENTITIES.NAME_ONLY,
    }),
    describe: () => describeModel(settings, fetchImpl, describeTimeoutMs),
    generate: (input) =>
      generate(settings, fetchImpl, generationTimeoutMs, input),
  };
}
