import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOllamaAgent } from '@gyblos/engine-ollama/agent';
import { MODEL } from '@gyblos/engine-ollama/constants';

import { request } from './support/paypal-agent-ollama-request';

void test('OpenCode length, item and prefix constraints are checked before returning a tool call', async () => {
  let args = { query: 'ok', questions: ['one'], sessionID: 'ses_test' };
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
        tool_calls: [{ function: { name: 'read_file', arguments: args } }],
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
            type: 'object',
            properties: {
              query: { type: 'string', minLength: 2 },
              questions: { type: 'array', minItems: 1 },
              sessionID: { type: 'string', pattern: '^ses' },
            },
            required: ['query', 'questions', 'sessionID'],
          },
        },
      },
    ],
  };
  assert.doesNotThrow(() => engine.validate(input));
  await assert.doesNotReject(engine.generate(input));
  assert.ok(
    sent &&
      typeof sent === 'object' &&
      'tools' in sent &&
      Array.isArray(sent.tools),
  );
  const properties = sent.tools[0].function.parameters.properties;
  assert.equal(properties.query.minLength, undefined);
  assert.equal(properties.questions.minItems, undefined);
  assert.equal(properties.sessionID.pattern, undefined);
  assert.match(properties.query.description, /2/);
  assert.match(properties.questions.description, /1/);
  assert.match(properties.sessionID.description, /ses/);

  args = { query: '🧠', questions: ['one'], sessionID: 'ses_test' };
  await assert.rejects(engine.generate(input));
  args = { query: 'ok', questions: [], sessionID: 'ses_test' };
  await assert.rejects(engine.generate(input));
  args = { query: 'ok', questions: ['one'], sessionID: 'other_ses' };
  await assert.rejects(engine.generate(input));
  args = { query: '🧠a', questions: ['one'], sessionID: 'ses_test' };
  await assert.doesNotReject(engine.generate(input));
});

void test('invalid bounds and complex tool patterns remain rejected before inference', () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return Response.json({});
  };
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  for (const constraint of [
    { minLength: -1 },
    { minLength: 0.5 },
    { minItems: -1 },
    { pattern: '^(a+)+$' },
  ]) {
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
                properties: { path: { ...constraint } },
              },
            },
          },
        ],
      }),
    );
  }
  assert.equal(calls, 0);
});

void test('nested alternatives count Unicode characters correctly at different minimum lengths', async () => {
  let value = '🧠a🧠b🧠c';
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
          { function: { name: 'read_file', arguments: { query: value } } },
        ],
      },
      prompt_eval_count: 2,
      eval_count: 3,
    });
  const engine = createOllamaAgent('http://127.0.0.1:11434/', fetcher);
  const input = {
    ...request,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                anyOf: [{ minLength: 8 }, { minLength: 7 }, { minLength: 6 }],
              },
            },
          },
        },
      },
    ],
  };
  await assert.doesNotReject(engine.generate(input));
  value = '🧠a🧠b🧠';
  await assert.rejects(engine.generate(input));
});

void test('duplicate tool names are rejected before inference', () => {
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
            parameters: { type: 'object', properties: {} },
          },
        },
        {
          type: 'function',
          function: {
            name: 'read_file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string', minLength: 1 } },
            },
          },
        },
      ],
    }),
  );
  assert.equal(calls, 0);
});
