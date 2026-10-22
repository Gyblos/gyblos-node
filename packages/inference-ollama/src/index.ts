import { IPV6_LOOPBACK, LOCALHOST, ROUTES, TIMEOUTS } from '@gyblos/config';
import {
  ENGINE_DONE_REASONS,
  GENERATION,
  MODEL_LIMITS,
  type EngineDoneReason,
} from '@gyblos/inference-ollama/constants';
import { MODEL, renderChat } from '@gyblos/inference-ollama/model';
import type { EngineWireUsage as EngineUsage } from '@gyblos/protocol/wire-usage';

export type { EngineWireUsage as EngineUsage } from '@gyblos/protocol/wire-usage';

export interface InferenceResult {
  text: string;
  usage: EngineUsage;
  done: true;
  doneReason: EngineDoneReason;
}

export { MODEL, renderChat } from '@gyblos/inference-ollama/model';

export {
  createModelTokenizer,
  type ModelTokenizer,
} from '@gyblos/inference-ollama/tokenizer';

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
        signal: AbortSignal.any([
          AbortSignal.timeout(TIMEOUTS.generation),
          ...(input.signal ? [input.signal] : []),
        ]),
      });
      if (!response.ok || !response.body)
        throw new Error('Local engine generation failed.');
      // Streaming is internal to the adapter, solely for bounded buffering and fault injection.
      // The paid HTTP response remains fully buffered until settlement.
      let buffer = '',
        text = '',
        terminal: Record<string, unknown> | undefined;
      let fragments = 0;
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const part = await reader.read();
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
            if (typeof event.response !== 'string')
              throw new Error('Missing engine text.');
            text += event.response;
            if (text.length > MODEL_LIMITS.maxOutputCharacters)
              throw new Error('Engine output exceeds limit.');
            if (event.response) {
              fragments++;
              await input.onFragment?.();
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
        const usageValue = (key: keyof EngineUsage): number => {
          const value = terminalFrame[key];
          if (
            typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            value < 0
          )
            throw new Error('Invalid engine usage.');
          return value;
        };
        const usage: EngineUsage = {
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
        await reader.cancel().catch(() => {});
      }
    },
  };
}
