import { MODEL, renderChat } from './model.js';

export { MODEL, renderChat } from './model.js';
export { createModelTokenizer, type ModelTokenizer } from './tokenizer.js';

export interface EngineUsage {
  prompt_eval_count: number;
  eval_count: number;
  total_duration: number;
  load_duration: number;
  prompt_eval_duration: number;
  eval_duration: number;
}
export interface InferenceResult {
  text: string;
  usage: EngineUsage;
  done: true;
  doneReason: string;
}

export function localOllamaUrl(base: string): URL {
  const url = new URL(base);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
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
    const response = await fetchImpl(new URL('/api/tags', origin), {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
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
        input.maxTokens > 512
      )
        throw new Error('Invalid output token limit.');
      input.signal?.throwIfAborted();
      await assertModel();
      input.signal?.throwIfAborted();
      const response = await fetchImpl(new URL('/api/generate', origin), {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL.name,
          prompt: renderChat(input.prompt),
          raw: true,
          stream: true,
          keep_alive: '5m',
          options: {
            temperature: 0,
            seed: 42,
            num_predict: input.maxTokens,
            num_ctx: 2048,
          },
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(90_000),
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
          if (buffer.length > 1_000_000)
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
            if (text.length > 100_000)
              throw new Error('Engine output exceeds limit.');
            if (event.response) {
              fragments++;
              await input.onFragment?.();
            }
            if (event.done === true) terminal = event;
          }
          if (part.done) break;
        }
        if (
          buffer.trim() ||
          !terminal ||
          !fragments ||
          !['stop', 'length'].includes(String(terminal.done_reason))
        )
          throw new Error('Incomplete engine response.');
        const usage = Object.fromEntries(
          [
            'prompt_eval_count',
            'eval_count',
            'total_duration',
            'load_duration',
            'prompt_eval_duration',
            'eval_duration',
          ].map((key) => {
            const value = terminal![key];
            if (!Number.isSafeInteger(value) || Number(value) < 0)
              throw new Error('Invalid engine usage.');
            return [key, value];
          }),
        ) as unknown as EngineUsage;
        return {
          text,
          usage,
          done: true,
          doneReason: String(terminal.done_reason),
        };
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
  };
}
