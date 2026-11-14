// What a real Codex CLI session needs from the Responses route: its always-offered web search left out,
// reasoning and search records from another provider skipped, images kept as a placeholder so the session
// goes on, one turn's calls checked together before any seller, a full context reported so Codex compacts,
// and a paid endpoint refusing its tools plainly. Injected executors and loopback ports only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_EXECUTION } from '@gyblos/protocol/constants';
import type { FreeExecutionBuildInput } from '@gyblos/protocol/free-execution';

import { CODEX, host, post, TEXT, user } from './support/buyer-responses';

const call = (id: string) => ({
  type: 'function_call',
  call_id: id,
  name: 'shell',
  arguments: '{"command":["ls"]}',
});
const output = (id: string, value: unknown = 'ok') => ({
  type: 'function_call_output',
  call_id: id,
  output: value,
});

void test('web search is not offered, and reasoning or search records from another provider are skipped', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen);
  try {
    const response = await post(server.url, {
      ...CODEX,
      input: [
        user('find it'),
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'x' },
        { type: 'web_search_call', id: 'ws_1', status: 'completed' },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'found' }],
        },
        user('thanks'),
      ],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      seen[0]?.tools?.map((tool) => tool.name),
      ['shell'],
    );
    assert.deepEqual(
      seen[0]?.messages.map((message) => message.role),
      ['user', 'assistant', 'user'],
    );
  } finally {
    await server.close();
  }
});

void test('an image, pasted or returned by a tool, becomes a placeholder so the session goes on', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen);
  try {
    const image = {
      type: 'input_image',
      image_url: 'data:image/png;base64,AA',
    };
    const response = await post(server.url, {
      ...CODEX,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'look' }, image],
        },
        call('c1'),
        output('c1', [image]),
        user('and?'),
      ],
    });
    assert.equal(response.status, 200);
    const contents = seen[0]?.messages.map((message) => message.content);
    assert.match(String(contents?.[0]), /^look\n\n\[image omitted/);
    assert.match(String(contents?.[2]), /^\[image omitted/);
  } finally {
    await server.close();
  }
});

void test("one turn's calls are checked together: a repeated id or too many calls is a 400 before any seller", async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen);
  try {
    const many = Array.from({ length: 33 }, (_, index) => `c${index}`);
    for (const input of [
      [user('go'), call('a'), call('a'), output('a'), user('next')],
      [
        user('go'),
        ...many.map(call),
        ...many.map((id) => output(id)),
        user('next'),
      ],
    ]) {
      const response = await post(server.url, { ...CODEX, input });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.param, 'input');
    }
    assert.equal(seen.length, 0);
  } finally {
    await server.close();
  }
});

void test('a conversation over the size the network carries is a full context, so Codex compacts', async () => {
  const server = await host(TEXT, []);
  try {
    const response = await post(server.url, {
      ...CODEX,
      input: [user('x'.repeat(FREE_EXECUTION.inputBytes + 1))],
    });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.code, 'context_length_exceeded');
    assert.equal(error.gyblos_code, 'FREE_BUYER_INVALID_REQUEST');
  } finally {
    await server.close();
  }
});

void test('an endpoint that may route to paid execution refuses Codex tools plainly', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen, false);
  try {
    const response = await post(server.url, { ...CODEX, input: [user('hi')] });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /free offers only/);
    assert.equal(seen.length, 0);
  } finally {
    await server.close();
  }
});

void test('a call from a tool group earlier in the session stays as history', async () => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen);
  try {
    // Codex CLI 0.162 records which group a call came from, e.g. an MCP server used on another provider.
    const response = await post(server.url, {
      ...CODEX,
      input: [
        user('use the tool'),
        { ...call('call_1'), namespace: 'mcp__demo' },
        output('call_1'),
        user('thanks'),
      ],
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      seen[0]?.messages.map((message) => message.role),
      ['user', 'assistant', 'tool', 'user'],
    );
  } finally {
    await server.close();
  }
});

void test('MCP tools Codex sends are not offered, and the operator is told once', async (t) => {
  const seen: FreeExecutionBuildInput[] = [];
  const server = await host(TEXT, seen);
  const notices: string[] = [];
  t.mock.method(console, 'error', (line: string) => notices.push(line));
  try {
    const mcp = {
      type: 'namespace',
      name: 'mcp__demo',
      description: 'A local MCP server',
      tools: [{ type: 'function', name: 'echo', parameters: {} }],
    };
    for (let turn = 0; turn < 2; turn++) {
      const response = await post(server.url, {
        ...CODEX,
        tools: [...CODEX.tools, mcp],
        input: [user('hi')],
      });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(
      seen[0]?.tools?.map((tool) => tool.name),
      ['shell'],
    );
    assert.equal(notices.filter((line) => /MCP/.test(line)).length, 1);
    assert.equal(notices.join('\n').includes('demo'), false);
  } finally {
    await server.close();
  }
});
