// Ollama HTTP client restricted to a literal loopback origin: checks the pinned model is present and runs
// bounded, deterministic raw generations. Failures follow the Engine port contract in @gyblos/protocol/engine.
// It must not know wallets or payments.
import { IPV6_LOOPBACK, LOCALHOST, ROUTES, TIMEOUTS } from '@gyblos/config';
import {
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
  type EngineDoneReason,
} from '@gyblos/protocol/constants';
import { EngineError } from '@gyblos/protocol/engine';
import type { EngineWireUsage } from '@gyblos/protocol/wire-usage';

import { GENERATION, MODEL_LIMITS } from './constants';
import {
  BoundFailure,
  callerCallback,
  engineFailure,
  FrameFailure,
  statusFailure,
  type EngineAttempt,
} from './failures';
import { MODEL, renderChat } from './model';

export interface InferenceResult {
  text: string;
  usage: EngineWireUsage;
  done: true;
  doneReason: EngineDoneReason;
}

export { renderChat } from './model';

export { createModelTokenizer, type ModelTokenizer } from './tokenizer';

// True for a literal loopback HTTP origin: 127.0.0.1 or [::1] on a real port, without credentials, path,
// query or fragment.
export function isLocalOllamaUrl(base: string): boolean {
  if (!URL.canParse(base)) return false;
  const url = new URL(base);
  return (
    url.protocol === 'http:' &&
    [LOCALHOST, IPV6_LOOPBACK].includes(url.hostname) &&
    url.port !== '0' &&
    !url.username &&
    !url.password &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash
  );
}

export function localOllamaUrl(base: string): URL {
  if (!isLocalOllamaUrl(base))
    throw new Error('Ollama must use a literal loopback HTTP origin.');
  return new URL(base);
}

export interface OllamaOptions {
  generationTimeoutMs?: number;
  modelCheckTimeoutMs?: number;
}
interface GenerateInput {
  prompt: string;
  maxTokens: number;
  signal?: AbortSignal;
  onFragment?: () => Promise<void>;
  onText?: (text: string) => Promise<void>;
}

function frameEvent(line: string): Record<string, unknown> {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    throw new FrameFailure();
  }
  if (!event || typeof event !== 'object' || Array.isArray(event))
    throw new FrameFailure();
  return Object.fromEntries(Object.entries(event));
}
function terminalUsage(terminal: Record<string, unknown>): EngineWireUsage {
  const usageValue = (key: keyof EngineWireUsage): number => {
    const value = terminal[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new FrameFailure();
    return value;
  };
  return {
    prompt_eval_count: usageValue('prompt_eval_count'),
    eval_count: usageValue('eval_count'),
    total_duration: usageValue('total_duration'),
    load_duration: usageValue('load_duration'),
    prompt_eval_duration: usageValue('prompt_eval_duration'),
    eval_duration: usageValue('eval_duration'),
  };
}
function doneReason(terminal: Record<string, unknown>): EngineDoneReason {
  const reason = terminal.done_reason;
  if (reason === ENGINE_DONE_REASONS.STOP) return ENGINE_DONE_REASONS.STOP;
  if (reason === ENGINE_DONE_REASONS.LENGTH) return ENGINE_DONE_REASONS.LENGTH;
  throw new FrameFailure();
}

// The optional text callback receives bounded fragments with backpressure.
// Callers without it, including paid HTTP, retain the complete buffered result.
async function readGeneration(
  body: ReadableStream<Uint8Array>,
  input: GenerateInput,
  signal: AbortSignal,
  attempt: EngineAttempt,
): Promise<InferenceResult> {
  let buffer = '';
  let text = '';
  let terminal: Record<string, unknown> | undefined;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      try {
        buffer += decoder.decode(part.value, { stream: !part.done });
      } catch {
        throw new FrameFailure();
      }
      if (buffer.length > MODEL_LIMITS.maxFrameCharacters)
        throw new BoundFailure();
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = frameEvent(line);
        if (event.error) throw new FrameFailure(true);
        if (
          terminal ||
          event.model !== MODEL.name ||
          (event.thinking !== undefined && event.thinking !== '') ||
          typeof event.response !== 'string' ||
          /[\uD800-\uDFFF]/u.test(event.response)
        )
          throw new FrameFailure();
        text += event.response;
        if (text.length > MODEL_LIMITS.maxOutputCharacters)
          throw new BoundFailure();
        if (event.response) {
          const fragment = event.response;
          attempt.fragments++;
          signal.throwIfAborted();
          await callerCallback(attempt, input.onFragment);
          signal.throwIfAborted();
          const onText = input.onText;
          await callerCallback(attempt, onText && (() => onText(fragment)));
          signal.throwIfAborted();
        }
        if (event.done === true) terminal = event;
      }
      if (part.done) break;
    }
    if (buffer.trim() || !terminal || !attempt.fragments)
      throw new FrameFailure();
    return {
      text,
      usage: terminalUsage(terminal),
      done: true,
      doneReason: doneReason(terminal),
    };
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}

// Ollama's own inventory is local: any refusal or a changed pin means the model is unavailable.
async function checkModel(
  origin: URL,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const attempt: EngineAttempt = { caller: signal, deadline, fragments: 0 };
  try {
    const response = await fetchImpl(new URL(ROUTES.ollamaTags, origin), {
      redirect: 'error',
      signal: AbortSignal.any([deadline, ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new EngineError(ENGINE_ERROR_CODES.UNAVAILABLE);
    }
    const body: unknown = await response.json();
    const models: unknown =
      body && typeof body === 'object'
        ? Reflect.get(body, 'models')
        : undefined;
    const model = Array.isArray(models)
      ? models.find(
          (item: unknown) =>
            !!item &&
            typeof item === 'object' &&
            Reflect.get(item, 'name') === MODEL.name,
        )
      : undefined;
    if (
      !model ||
      Reflect.get(model, 'digest') !== MODEL.digest ||
      Reflect.get(model, 'remote_model')
    )
      throw new EngineError(ENGINE_ERROR_CODES.UNAVAILABLE);
  } catch (error) {
    throw engineFailure(error, attempt);
  }
}

export function createOllama(
  base: string,
  fetchImpl: typeof fetch = fetch,
  options: OllamaOptions = {},
) {
  const origin = localOllamaUrl(base);
  const generationTimeoutMs =
    options.generationTimeoutMs ?? TIMEOUTS.generation;
  const modelCheckTimeoutMs = options.modelCheckTimeoutMs ?? TIMEOUTS.events;
  const assertModel = (signal?: AbortSignal) =>
    checkModel(origin, fetchImpl, modelCheckTimeoutMs, signal);
  return {
    assertModel,
    async generate(input: GenerateInput): Promise<InferenceResult> {
      if (
        !Number.isSafeInteger(input.maxTokens) ||
        input.maxTokens < 1 ||
        input.maxTokens > MODEL_LIMITS.adapterMaxOutputTokens
      )
        throw new Error('Invalid output token limit.');
      // An unsupported prompt is a programming error, raised before any engine call.
      const prompt = renderChat(input.prompt);
      input.signal?.throwIfAborted();
      await assertModel(input.signal);
      input.signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(generationTimeoutMs);
      const attempt: EngineAttempt = {
        caller: input.signal,
        deadline,
        fragments: 0,
      };
      const signal = AbortSignal.any([
        deadline,
        ...(input.signal ? [input.signal] : []),
      ]);
      try {
        const response = await fetchImpl(
          new URL(ROUTES.ollamaGenerate, origin),
          {
            method: 'POST',
            redirect: 'error',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: MODEL.name,
              prompt,
              raw: true,
              stream: true,
              keep_alive: GENERATION.keepAlive,
              options: {
                temperature: GENERATION.temperature,
                seed: GENERATION.seed,
                num_predict: input.maxTokens,
                num_ctx: GENERATION.numCtx,
              },
            }),
            signal,
          },
        );
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw statusFailure(response.status);
        }
        return await readGeneration(response.body, input, signal, attempt);
      } catch (error) {
        throw engineFailure(error, attempt);
      }
    },
  };
}
