// Ollama HTTP client restricted to a literal loopback origin: checks the pinned model is present and runs
// bounded, deterministic raw generations. It must not know wallets or payments.
import { IPV6_LOOPBACK, LOCALHOST, ROUTES, TIMEOUTS } from '@gyblos/config';
import {
  ENGINE_DONE_REASONS,
  type EngineDoneReason,
} from '@gyblos/protocol/constants';
import type { EngineWireUsage } from '@gyblos/protocol/wire-usage';

import { GENERATION, MODEL_LIMITS } from './constants.js';
import { MODEL, renderChat } from './model.js';

export interface InferenceResult {
  text: string;
  usage: EngineWireUsage;
  done: true;
  doneReason: EngineDoneReason;
}

export { renderChat } from './model.js';

export { createModelTokenizer, type ModelTokenizer } from './tokenizer.js';

export function localOllamaUrl(base: string): URL {
  const url = new URL(base);
  if (
    url.protocol !== 'http:' ||
    ![LOCALHOST, IPV6_LOOPBACK].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Ollama must use a literal loopback HTTP origin.');
  }
  return url;
}

export function createOllama(base: string, fetchImpl: typeof fetch = fetch) {
  const origin = localOllamaUrl(base);
  async function assertModel() {
    const response = await fetchImpl(new URL(ROUTES.ollamaTags, origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUTS.events),
    });
    if (!response.ok) throw new Error('Local model inventory unavailable.');
    const body = (await response.json()) as {
      models: { name: string; digest: string; remote_model?: string }[];
    };
    const model = body.models.find((item) => item.name === MODEL.name);
    if (model?.digest !== MODEL.digest || model.remote_model)
      throw new Error('Pinned local model is missing or changed.');
  }
  return {
    assertModel,
    async generate(input: {
      prompt: string;
      maxTokens: number;
      signal?: AbortSignal;
      onFragment?: () => Promise<void>;
      onText?: (text: string) => Promise<void>;
    }): Promise<InferenceResult> {
      if (
        !Number.isSafeInteger(input.maxTokens) ||
        input.maxTokens < 1 ||
        input.maxTokens > MODEL_LIMITS.adapterMaxOutputTokens
      )
        throw new Error('Invalid output token limit.');
      input.signal?.throwIfAborted();
      await assertModel();
      input.signal?.throwIfAborted();
      const signal = AbortSignal.any([
        AbortSignal.timeout(TIMEOUTS.generation),
        ...(input.signal ? [input.signal] : []),
      ]);
      const response = await fetchImpl(new URL(ROUTES.ollamaGenerate, origin), {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL.name,
          prompt: renderChat(input.prompt),
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
      });
      if (!response.ok || !response.body)
        throw new Error('Local engine generation failed.');
      // The optional text callback receives bounded fragments with backpressure.
      // Callers without it, including paid HTTP, retain the complete buffered result.
      let buffer = '';
      let text = '';
      let terminal: Record<string, unknown> | undefined;
      let fragments = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const reader = response.body.getReader();
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
          buffer += decoder.decode(part.value, { stream: !part.done });
          if (buffer.length > MODEL_LIMITS.maxFrameCharacters)
            throw new Error('Engine frame exceeds limit.');
          let newline: number;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line) as Record<string, unknown>;
            if (
              terminal ||
              event.error ||
              event.model !== MODEL.name ||
              (event.thinking !== undefined && event.thinking !== '')
            )
              throw new Error('Invalid or unexpected engine frame.');
            if (
              typeof event.response !== 'string' ||
              /[\uD800-\uDFFF]/u.test(event.response)
            )
              throw new Error('Missing engine text.');
            text += event.response;
            if (text.length > MODEL_LIMITS.maxOutputCharacters)
              throw new Error('Engine output exceeds limit.');
            if (event.response) {
              fragments++;
              signal.throwIfAborted();
              await input.onFragment?.();
              signal.throwIfAborted();
              await input.onText?.(event.response);
              signal.throwIfAborted();
            }
            if (event.done === true) terminal = event;
          }
          if (part.done) break;
        }
        if (buffer.trim() || !terminal || !fragments)
          throw new Error('Incomplete engine response.');
        const doneReason = String(terminal.done_reason);
        if (
          doneReason !== ENGINE_DONE_REASONS.STOP &&
          doneReason !== ENGINE_DONE_REASONS.LENGTH
        )
          throw new Error('Incomplete engine response.');
        const terminalFrame = terminal;
        const usageValue = (key: keyof EngineWireUsage): number => {
          const value = terminalFrame[key];
          if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < 0
          )
            throw new Error('Invalid engine usage.');
          return value;
        };
        const usage: EngineWireUsage = {
          prompt_eval_count: usageValue('prompt_eval_count'),
          eval_count: usageValue('eval_count'),
          total_duration: usageValue('total_duration'),
          load_duration: usageValue('load_duration'),
          prompt_eval_duration: usageValue('prompt_eval_duration'),
          eval_duration: usageValue('eval_duration'),
        };
        return {
          text,
          usage,
          done: true,
          doneReason,
        };
      } finally {
        signal.removeEventListener('abort', cancel);
        await reader.cancel().catch(() => {});
      }
    },
  };
}
