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
    assert.equal(String(url), 'http://127.0.0.1:11434/api/chat');
    assert.equal(init?.redirect, 'error');
    assert.equal(typeof init?.body, 'string');
    if (typeof init?.body !== 'string') throw new Error('missing body');
    sent = JSON.parse(init.body);
    return Response.json({
      model: MODEL.name,
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', function: { name: 'read_file', arguments: {} } },
        ],
      },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  const result: unknown = await engine.generate(request);
  assert.deepEqual(sent, {
    model: request.model,
    messages: request.messages,
    tools: request.tools,
    stream: false,
    truncate: false,
    shift: false,
    options: { num_ctx: 8192, num_predict: 128 },
  });
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
    if (String(url).endsWith('/api/version'))
      return Response.json({ version: '0.40.0' });
    if (String(url).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: chosen, digest, capabilities: ['tools'] }],
      });
    assert.equal(typeof init?.body, 'string');
    if (typeof init?.body !== 'string') throw new Error('missing body');
    const sent: unknown = JSON.parse(init.body);
    assert.ok(sent && typeof sent === 'object' && 'model' in sent);
    assert.equal(sent.model, chosen);
    return Response.json({
      model: chosen,
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'stop',
      message: { role: 'assistant', content: 'synthetic answer' },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher, {
    model: chosen,
  });
  assert.equal((await engine.describe()).name, chosen);
  await engine.generate({ ...request, model: chosen });
  digest = 'b'.repeat(64);
  await assert.rejects(engine.describe());
});

void test('native agent requests disable context truncation and preserve tool-call history', async () => {
  let sent: unknown;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:11434/api/chat');
    assert.equal(typeof init?.body, 'string');
    if (typeof init?.body !== 'string') throw new Error('missing body');
    sent = JSON.parse(init.body);
    return Response.json({
      model: MODEL.name,
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'read_file',
              arguments: { path: 'synthetic.txt' },
            },
          },
        ],
      },
      prompt_eval_count: 20,
      eval_count: 5,
    });
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  const input = {
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: '{"path":"synthetic.txt"}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'synthetic contents' },
    ],
  };
  const result: unknown = await engine.generate(input);
  assert.ok(sent && typeof sent === 'object');
  assert.ok('truncate' in sent && sent.truncate === false);
  assert.ok('shift' in sent && sent.shift === false);
  assert.ok(
    'options' in sent && sent.options && typeof sent.options === 'object',
  );
  assert.ok('num_ctx' in sent.options && sent.options.num_ctx === 8192);
  assert.ok('num_predict' in sent.options && sent.options.num_predict === 128);
  assert.ok('messages' in sent && Array.isArray(sent.messages));
  assert.deepEqual(sent.messages[2], {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_1',
        function: { name: 'read_file', arguments: { path: 'synthetic.txt' } },
      },
    ],
  });
  assert.deepEqual(sent.messages[3], {
    role: 'tool',
    tool_call_id: 'call_1',
    tool_name: 'read_file',
    content: 'synthetic contents',
  });
  assert.ok(
    result &&
      typeof result === 'object' &&
      'choices' in result &&
      Array.isArray(result.choices),
  );
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(result.choices[0].message.tool_calls[0].function, {
    name: 'read_file',
    arguments: '{"path":"synthetic.txt"}',
  });
  assert.ok(result.choices[0].message.tool_calls[0].id);
});

void test('model verification rejects an Ollama version that can ignore context controls', async () => {
  let version = '0.12.5';
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith('/api/version')) return Response.json({ version });
    return Response.json({
      models: [
        {
          name: MODEL.name,
          digest: 'a'.repeat(64),
          capabilities: ['tools'],
        },
      ],
    });
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.describe());
  version = '0.19.9';
  await assert.rejects(engine.describe());
  version = '0.20.0';
  assert.equal((await engine.describe()).name, MODEL.name);
});

void test('unsupported tool schemas are rejected before contacting Ollama', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json({});
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  assert.throws(() =>
    engine.validate({
      ...request,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string', pattern: 'secret' } },
            },
          },
        },
      ],
    }),
  );
  assert.equal(calls, 0);
});

void test('a tool call truncated by the model is never returned for execution', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({
      model: MODEL.name,
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'length',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
      },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.generate(request));
});

void test('tool arguments must satisfy the supported schema before returning them', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({
      model: MODEL.name,
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'stop',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'read_file', arguments: { path: 1 } } },
        ],
      },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(
    engine.generate({
      ...request,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
        },
      ],
    }),
  );
});

void test('remote model aliases and remote inference results are not accepted', async () => {
  assert.throws(() =>
    createOllamaAgent('http://127.0.0.1:11434/', fetch, {
      model: 'other-cloud',
    }),
  );
  const fetcher: typeof fetch = async () =>
    Response.json({
      model: MODEL.name,
      remote_host: 'https://remote.invalid',
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'stop',
      message: { role: 'assistant', content: 'synthetic' },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.generate(request));
});

void test('model capabilities are read from show when the tags catalog omits them', async () => {
  const fetcher: typeof fetch = async (url) => {
    if (String(url).endsWith('/api/version')) return Response.json({ version: '0.20.0' });
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: MODEL.name, digest: 'a'.repeat(64) }] });
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'tools'] });
    throw new Error('Unexpected request');
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  assert.equal((await engine.describe()).name, MODEL.name);
});

void test('duplicate tool call IDs are rejected before the agent sees them', async () => {
  const call = { id: 'duplicate', function: { name: 'read_file', arguments: {} } };
  const fetcher: typeof fetch = async () => Response.json({
    model: MODEL.name, created_at: '2026-01-01T00:00:00Z', done: true,
    done_reason: 'stop', message: { role: 'assistant', content: '', tool_calls: [call, call] },
    prompt_eval_count: 2, eval_count: 3,
  });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.generate(request));
});

void test('an empty assistant response cannot be presented as completed work', async () => {
  const fetcher: typeof fetch = async () => Response.json({
    model: MODEL.name, created_at: '2026-01-01T00:00:00Z', done: true,
    done_reason: 'length', message: { role: 'assistant', content: '' },
    prompt_eval_count: 2, eval_count: 3,
  });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.generate(request));
});
