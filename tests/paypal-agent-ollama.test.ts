import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOllamaAgent } from '@gyblos/engine-ollama/agent';
import { MODEL } from '@gyblos/engine-ollama/constants';

const request = {
  model: MODEL.name,
  messages: [
    { role: 'system', content: 'synthetic instruction' },
    { role: 'user', content: 'synthetic request' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'read_file',
        parameters: { type: 'object', properties: {} },
      },
    },
  ],
  max_tokens: 128,
  stream: true,
};

void test('agent adapter preserves history and tool calls through the local Ollama API', async () => {
  let sent: unknown;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal(typeof init?.body, 'string');
    if (typeof init?.body !== 'string') throw new Error('missing body');
    sent = JSON.parse(init.body);
    return Response.json({
      id: 'synthetic-id',
      object: 'chat.completion',
      created: 0,
      model: MODEL.name,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  const result: unknown = await engine.generate(request);
  assert.deepEqual(sent, { ...request, stream: false });
  assert.ok(result && typeof result === 'object' && 'choices' in result);
  assert.deepEqual(result.choices, [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ]);
});

void test('agent adapter rejects remote destinations and a different model', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response('{}');
  };
  assert.throws(() => createOllamaAgent('https://seller.invalid/', fetcher));
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.generate({ ...request, model: 'other' }));
  assert.equal(calls, 0);
});

void test('agent adapter rejects malformed responses without exposing the upstream body', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({ model: MODEL.name, secret: 'synthetic upstream detail' });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.generate(request), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /synthetic upstream detail/);
    return true;
  });
});

void test('an explicitly selected local agent model is used and verified', async () => {
  const chosen = 'synthetic-tool-model';
  let digest = 'a'.repeat(64);
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/api/tags'))
      return Response.json({ models: [{ name: chosen, digest, capabilities: ['tools'] }] });
    assert.equal(typeof init?.body, 'string');
    if (typeof init?.body !== 'string') throw new Error('missing body');
    const sent: unknown = JSON.parse(init.body);
    assert.ok(sent && typeof sent === 'object' && 'model' in sent);
    assert.equal(sent.model, chosen);
    return Response.json({
      id: 'synthetic-id', object: 'chat.completion', created: 0, model: chosen,
      choices: [{ index: 0, message: { role: 'assistant', content: 'synthetic answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher, { model: chosen });
  assert.equal((await engine.describe()).name, chosen);
  await engine.generate({ ...request, model: chosen });
  digest = 'b'.repeat(64);
  await assert.rejects(engine.describe());
});
