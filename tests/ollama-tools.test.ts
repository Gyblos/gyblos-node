// The Ollama engine with tools: the prompt carries the template's tools block, text streams up to a call, and a
// well-formed call comes back in the result with finish reason tool_calls; anything else stays text. A
// synthetic fetch stands in for Ollama; no model or network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { MODEL } from '@gyblos/engine-ollama/constants';
import { createOllamaEngine } from '@gyblos/engine-ollama/engine';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import { TOOL_CALLS_DONE, type ToolDefinition } from '@gyblos/protocol/tools';

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_time',
    parameters: '{"type":"object","properties":{"zone":{"type":"string"}}}',
  },
];
const frame = (response: string, done = false) =>
  JSON.stringify({
    model: MODEL.name,
    response,
    done,
    ...(done
      ? {
          done_reason: ENGINE_DONE_REASONS.STOP,
          prompt_eval_count: 9,
          eval_count: 7,
          total_duration: 3,
          load_duration: 0,
          prompt_eval_duration: 1,
          eval_duration: 2,
        }
      : {}),
  }) + '\n';

function ollama(fragments: string[]) {
  const prompts: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: MODEL.name, digest: MODEL.digest }],
      });
    prompts.push(JSON.parse(String(init?.body)).prompt);
    const body = fragments.map((part, index) =>
      frame(part, index === fragments.length - 1),
    );
    return new Response(body.join(''), {
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };
  return {
    engine: createOllamaEngine('http://127.0.0.1:11434/', fetchImpl),
    prompts,
  };
}

void test('a call to an offered tool comes back in the result, and its markup never streams as text', async () => {
  const { engine, prompts } = ollama([
    'Checking.',
    '\n<tool_call>\n{"name": "get_time", ',
    '"arguments": {"zone": "UTC"}}\n</tool_call>',
  ]);
  assert.equal(engine.supportsTools?.(), true);
  const streamed: string[] = [];
  const result = await engine.generate({
    messages: [{ role: 'user', content: 'Time?' }],
    tools: TOOLS,
    maxTokens: 50,
    onText: async (text) => {
      streamed.push(text);
    },
  });
  assert.match(prompts[0]!, /# Tools[\s\S]*"name": "get_time"/);
  assert.equal(streamed.join(''), 'Checking.');
  assert.equal(result.text, 'Checking.');
  assert.equal(result.finishReason, TOOL_CALLS_DONE);
  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls?.[0]?.name, 'get_time');
  assert.equal(result.toolCalls?.[0]?.arguments, '{"zone":"UTC"}');
  assert.match(result.toolCalls?.[0]?.id ?? '', /^call_[0-9a-f]{32}$/);
});

void test('a call to an unknown tool is ordinary text, streamed whole', async () => {
  const raw = '<tool_call>\n{"name": "rm", "arguments": {}}\n</tool_call>';
  const { engine } = ollama([raw.slice(0, 15), raw.slice(15)]);
  const streamed: string[] = [];
  const result = await engine.generate({
    messages: [{ role: 'user', content: 'Time?' }],
    tools: TOOLS,
    maxTokens: 50,
    onText: async (text) => {
      streamed.push(text);
    },
  });
  assert.equal(result.finishReason, ENGINE_DONE_REASONS.STOP);
  assert.equal(result.toolCalls, undefined);
  assert.equal(result.text, raw);
  assert.equal(streamed.join(''), raw);
});

void test('a tool choice of none leaves the tools out of the prompt', async () => {
  const { engine, prompts } = ollama(['Noon.']);
  const result = await engine.generate({
    messages: [{ role: 'user', content: 'Time?' }],
    tools: TOOLS,
    toolChoice: 'none',
    maxTokens: 50,
  });
  assert.doesNotMatch(prompts[0]!, /# Tools/);
  assert.equal(result.text, 'Noon.');
});
