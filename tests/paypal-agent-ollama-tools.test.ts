import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOllamaAgent } from '@gyblos/engine-ollama/agent';
import { MODEL } from '@gyblos/engine-ollama/constants';

import { request } from './support/paypal-agent-ollama-request';

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
    if (String(url).endsWith('/api/version'))
      return Response.json({ version: '0.20.0' });
    if (String(url).endsWith('/api/tags'))
      return Response.json({
        models: [{ name: MODEL.name, digest: 'a'.repeat(64) }],
      });
    if (String(url).endsWith('/api/show'))
      return Response.json({ capabilities: ['completion', 'tools'] });
    throw new Error('Unexpected request');
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  assert.equal((await engine.describe()).name, MODEL.name);
});

void test('duplicate tool call IDs are rejected before the agent sees them', async () => {
  const call = {
    id: 'duplicate',
    function: { name: 'read_file', arguments: {} },
  };
  const fetcher: typeof fetch = async () =>
    Response.json({
      model: MODEL.name,
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'stop',
      message: { role: 'assistant', content: '', tool_calls: [call, call] },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.generate(request));
});

void test('an empty assistant response cannot be presented as completed work', async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({
      model: MODEL.name,
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'length',
      message: { role: 'assistant', content: '' },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(engine.generate(request));
});

void test('a new tool call cannot reuse an ID from previous history', async () => {
  const call = { id: 'call_1', function: { name: 'read_file', arguments: {} } };
  const fetcher: typeof fetch = async () =>
    Response.json({
      model: MODEL.name,
      created_at: '2026-01-01T00:00:00Z',
      done: true,
      done_reason: 'stop',
      message: { role: 'assistant', content: '', tool_calls: [call] },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  await assert.rejects(
    engine.generate({
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
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'synthetic' },
      ],
    }),
  );
});

void test('OpenCode read schemas retain numeric limits when validated locally', async () => {
  let sent: unknown;
  const fetcher: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== 'string') throw new Error('Missing body');
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
          { function: { name: 'read_file', arguments: { offset: -1 } } },
        ],
      },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  const input = {
    ...request,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0, maximum: 100 },
            },
          },
        },
      },
    ],
  };
  assert.doesNotThrow(() => engine.validate(input));
  await assert.rejects(engine.generate(input));
  assert.ok(
    sent &&
      typeof sent === 'object' &&
      'tools' in sent &&
      Array.isArray(sent.tools),
  );
  const schema = sent.tools[0].function.parameters;
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.properties.offset.minimum, undefined);
  assert.match(schema.properties.offset.description, /0/);
  assert.match(schema.properties.offset.description, /100/);
});

void test('exclusive numeric bounds in Claude Code tool schemas are enforced', async () => {
  let value = 0;
  const fetcher: typeof fetch = async () => Response.json({
    model: MODEL.name,
    created_at: '2026-01-01T00:00:00Z',
    done: true,
    done_reason: 'stop',
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { limit: value } } }] },
    prompt_eval_count: 2,
    eval_count: 3,
  });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  const input = {
    ...request,
    tools: [{ type: 'function', function: { name: 'read_file', parameters: {
      type: 'object', properties: { limit: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 3 } },
    } } }],
  };
  assert.doesNotThrow(() => engine.validate(input));
  await assert.rejects(engine.generate(input));
  value = 3;
  await assert.rejects(engine.generate(input));
  value = 1;
  await assert.doesNotReject(engine.generate(input));
});
