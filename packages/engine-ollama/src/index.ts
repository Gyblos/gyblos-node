// Ollama HTTP client restricted to a literal loopback origin: checks the pinned model is present and runs
// bounded, deterministic raw generations. Failures follow the Engine port contract in @gyblos/protocol/engine.
// It must not know wallets or payments.
import {
  generationDeadlineMs,
  IPV6_LOOPBACK,
  LOCALHOST,
  ROUTES,
  TIMEOUTS,
} from '@gyblos/config';
import {
  BoundFailure,
  callerCallback,
  engineFailure,
  FrameFailure,
  statusFailure,
  type EngineAttempt,
} from '@gyblos/core/engine-failures';
import {
  ENGINE_DONE_REASONS,
  ENGINE_ERROR_CODES,
  type EngineDoneReason,
} from '@gyblos/protocol/constants';
import {
  EngineError,
  engineToolConversation,
  type EngineInput,
} from '@gyblos/protocol/engine';
import {
  TOOL_CALLS_DONE,
  type ToolCall,
  type ToolDefinition,
} from '@gyblos/protocol/tools';
import type { EngineWireUsage } from '@gyblos/protocol/wire-usage';

import { GENERATION, MODEL_LIMITS } from './constants';
import { MODEL } from './model';
import {
  createToolStreamSplitter,
  parseToolOutput,
  renderInferenceConversation,
} from './tool-template';

export interface InferenceResult {
  text: string;
  usage: EngineWireUsage;
  done: true;
  doneReason: EngineDoneReason | typeof TOOL_CALLS_DONE;
  toolCalls?: ToolCall[];
}

export { renderChat, renderConversation } from './model';
export { renderAssistantOutput, renderToolConversation } from './tool-template';

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
  // The context Ollama allocates for each generation (num_ctx); GENERATION.numCtx by default.
  contextTokens?: number;
}
// A lone prompt or a whole conversation, as the Engine port takes it.
type GenerateInput = EngineInput;

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
  tools?: readonly ToolDefinition[],
): Promise<InferenceResult> {
  // With tools offered, text streams up to a possible call; the calls are read once generation ends.
  const splitter = tools ? createToolStreamSplitter() : undefined;
  const deliver = async (fragment: string) => {
    const onText = input.onText;
    if (!fragment || !onText) return;
    signal.throwIfAborted();
    await callerCallback(attempt, () => onText(fragment));
    signal.throwIfAborted();
  };
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
          await deliver(splitter ? splitter.push(fragment) : fragment);
        }
        if (event.done === true) terminal = event;
      }
      if (part.done) break;
    }
    if (buffer.trim() || !terminal || !attempt.fragments)
      throw new FrameFailure();
    return await finishGeneration(text, terminal, tools, async () => {
      if (splitter) await deliver(splitter.held());
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
}

// The calls the model wrote to offered tools, or its whole text when it wrote none well-formed (then the
// text held back from the stream is released first).
async function finishGeneration(
  text: string,
  terminal: Record<string, unknown>,
  tools: readonly ToolDefinition[] | undefined,
  release: () => Promise<void>,
): Promise<InferenceResult> {
  const usage = terminalUsage(terminal);
  const reason = doneReason(terminal);
  const called = tools && parseToolOutput(text, tools);
  if (called)
    return {
      text: called.text,
      toolCalls: called.toolCalls,
      usage,
      done: true,
      doneReason: TOOL_CALLS_DONE,
    };
  await release();
  return { text, usage, done: true, doneReason: reason };
}
// The raw prompt and the tools it offers. A tool choice of none renders the conversation without the tools
// block, so the model is not offered them. An unsupported conversation is a programming error, raised
// before any engine call.
function generationPrompt(input: GenerateInput) {
  return renderInferenceConversation(
    engineToolConversation(input),
    input.tools,
    input.toolChoice,
  );
}

// One deterministic raw generation of the rendered prompt.
const generateBody = (
  prompt: string,
  maxTokens: number,
  contextTokens: number,
) =>
  JSON.stringify({
    model: MODEL.name,
    prompt,
    raw: true,
    stream: true,
    keep_alive: GENERATION.keepAlive,
    options: {
      temperature: GENERATION.temperature,
      seed: GENERATION.seed,
      num_predict: maxTokens,
      num_ctx: contextTokens,
    },
  });
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
  const contextTokens = options.contextTokens ?? GENERATION.numCtx;
  if (
    !Number.isSafeInteger(contextTokens) ||
    contextTokens < MODEL_LIMITS.minContextTokens ||
    contextTokens > MODEL_LIMITS.maxContextTokens
  )
    throw new Error('Invalid Ollama context size.');
  return {
    assertModel,
    contextTokens,
    async generate(input: GenerateInput): Promise<InferenceResult> {
      if (
        !Number.isSafeInteger(input.maxTokens) ||
        input.maxTokens < 1 ||
        input.maxTokens > contextTokens
      )
        throw new Error('Invalid output token limit.');
      const { prompt, tools } = generationPrompt(input);
      input.signal?.throwIfAborted();
      await assertModel(input.signal);
      input.signal?.throwIfAborted();
      const deadline = AbortSignal.timeout(
        generationDeadlineMs(generationTimeoutMs, input.maxTokens),
      );
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
            body: generateBody(prompt, input.maxTokens, contextTokens),
            signal,
          },
        );
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {});
          throw statusFailure(response.status);
        }
        return await readGeneration(
          response.body,
          input,
          signal,
          attempt,
          tools,
        );
      } catch (error) {
        throw engineFailure(error, attempt);
      }
    },
  };
}
