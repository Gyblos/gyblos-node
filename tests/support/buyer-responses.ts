// Fixtures for the Responses API endpoint tests: results, a Codex-like request, and a host with injected
// executors on a loopback port.
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type {
  FreeExecutionBuildInput,
  FreeExecutionResult,
} from '@gyblos/protocol/free-execution';
import { TOOL_CALLS_DONE } from '@gyblos/protocol/tools';

export const MODEL = 'qwen3-0.6b';
export const SELECTION = { modelId: MODEL, variant: null, quantization: null };
export const TEXT: FreeExecutionResult = {
  text: 'hello there',
  usage: { inputTokens: 7, outputTokens: 2 },
  finishReason: ENGINE_DONE_REASONS.STOP,
};
export const CALLS: FreeExecutionResult = {
  text: '',
  toolCalls: [
    { id: 'call_a', name: 'shell', arguments: '{"command":["ls"]}' },
    { id: 'call_b', name: 'shell', arguments: '{"command":["pwd"]}' },
  ],
  usage: { inputTokens: 9, outputTokens: 4 },
  finishReason: TOOL_CALLS_DONE,
};
export const SHELL = {
  type: 'function',
  name: 'shell',
  description: 'Runs a command',
  strict: false,
  parameters: {
    type: 'object',
    properties: { command: { type: 'array', items: { type: 'string' } } },
    required: ['command'],
  },
};
// Shaped like what Codex CLI sends a custom provider: web search always offered, reasoning summaries asked.
export const CODEX = {
  model: MODEL,
  tools: [SHELL, { type: 'web_search', external_web_access: false }],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning: { summary: 'auto' },
  store: false,
  stream: false,
  include: [],
  prompt_cache_key: 'conversation-1',
  text: { verbosity: 'medium' },
  client_metadata: { originator: 'codex_cli' },
};
export const developer = (text: string) => ({
  type: 'message',
  role: 'developer',
  content: [{ type: 'input_text', text }],
});
export const user = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

export async function host(
  result:
    | FreeExecutionResult
    | ((
        onDelta: (text: string) => Promise<void>,
      ) => Promise<FreeExecutionResult>),
  seen: FreeExecutionBuildInput[],
  tools = true,
) {
  return startFreeBuyerHttp(
    async (input) => {
      seen.push(input);
      return typeof result === 'function' ? result(async () => {}) : result;
    },
    { selection: SELECTION, maxTokens: 100, tools },
    {
      port: 0,
      stream: async (input, _signal, onDelta) => {
        seen.push(input);
        if (typeof result === 'function') return result(onDelta);
        if (result.text) await onDelta(result.text);
        return result;
      },
    },
  );
}
export const responsesUrl = (url: string) =>
  url.replace(/\/v1\/chat\/completions$/, '/v1/responses');
export const post = (url: string, body: unknown) =>
  fetch(responsesUrl(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
export function events(stream: string) {
  return stream
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const data = block.split('\n').find((line) => line.startsWith('data: '));
      return JSON.parse(data?.slice('data: '.length) ?? 'null');
    });
}
