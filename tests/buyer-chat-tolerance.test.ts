import assert from 'node:assert/strict';
import test from 'node:test';

import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';
import { TOOL_LIMITS } from '@gyblos/protocol/tools';

import {
  CODEX,
  host,
  post,
  SHELL,
  TEXT,
  user,
} from './support/buyer-responses';

const tool = (name: string, description = 'Runs a command') => ({
  type: 'function',
  function: {
    name,
    description,
    parameters: { type: 'object', properties: {} },
  },
});
async function chat(body: Record<string, unknown>) {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen);
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: CODEX.model, ...body }),
    });
    return { status: response.status, body: await response.json(), seen };
  } finally {
    await server.close();
  }
}

void test('cache marks and another provider reasoning in the history are ignored, not refused', async () => {
  const { status, seen } = await chat({
    messages: [
      { role: 'system', content: 'be brief', cache_control: { type: 'x' } },
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'x' } }],
      },
      {
        role: 'assistant',
        content: 'hello',
        reasoning_content: 'thought',
        reasoning: 'thought',
        reasoning_details: [],
      },
      { role: 'user', content: 'again' },
    ],
  });
  assert.equal(status, 200);
  assert.deepEqual(
    seen[0]!.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ],
  );
});

void test('system text in the middle of a conversation joins the leading instructions', async () => {
  const { status, seen } = await chat({
    messages: [
      { role: 'system', content: 'first' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'system', content: 'reminder' },
      { role: 'user', content: 'again' },
    ],
  });
  assert.equal(status, 200);
  assert.deepEqual(seen[0]!.messages[0], {
    role: 'system',
    content: 'first\n\nreminder',
  });
  assert.equal(seen[0]!.messages.length, 4);
});

void test('a tool description over the limit is shortened to fit, not refused', async () => {
  const long = 'a' + '😀'.repeat(TOOL_LIMITS.descriptionBytes);
  const { status, seen, body } = await chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [tool('bash', long)],
  });
  assert.equal(status, 200, JSON.stringify(body));
  const sent = seen[0]!.tools![0]!.description!;
  assert.ok(Buffer.byteLength(sent) <= TOOL_LIMITS.descriptionBytes);
  assert.ok(long.startsWith(sent) && sent.length > 0);
});

for (const [name, tools, message] of [
  [
    'a name too long',
    [tool('ok'), tool('x'.repeat(TOOL_LIMITS.nameCharacters + 1))],
    /^tools\[1\]: a name must be/,
  ],
  [
    'a repeated name',
    [tool('same'), tool('same')],
    /^tools\[1\]: another tool/,
  ],
  [
    'a schema too large',
    [
      {
        type: 'function',
        function: {
          name: 'big',
          parameters: {
            type: 'object',
            description: 'x'.repeat(TOOL_LIMITS.jsonBytes),
          },
        },
      },
    ],
    /^tools\[0\]: the input schema/,
  ],
  [
    'too many tools',
    Array.from({ length: TOOL_LIMITS.maxTools + 1 }, (_, n) => tool(`t${n}`)),
    new RegExp(`^at most ${TOOL_LIMITS.maxTools} tools`),
  ],
] as const)
  void test(`a refused tool list says which tool and why: ${name}`, async () => {
    const { status, body } = await chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools,
    });
    assert.equal(status, 400);
    assert.match(body.error.message, message);
    assert.equal(body.error.param, 'tools');
  });

void test('a Responses tool refusal counts the tools the client sent, skipped ones included', async () => {
  const server = await host(TEXT, []);
  try {
    const response = await post(server.url, {
      ...CODEX,
      input: [user('hi')],
      tools: [{ type: 'web_search' }, SHELL, SHELL],
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error.message, /^tools\[2\]: another tool/);
  } finally {
    await server.close();
  }
});
