// The Qwen3 tool template against renderings of the pinned public chat template, the reader that takes calls
// back out of model output, and the stream splitter that keeps call markup out of streamed text. Pure.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { renderConversation } from '@gyblos/engine-ollama';
import {
  createToolStreamSplitter,
  parseToolOutput,
  renderAssistantOutput,
  renderToolConversation,
} from '@gyblos/engine-ollama/tool-template';
import type { ChatMessage } from '@gyblos/protocol/chat';
import type { ToolChatMessage, ToolDefinition } from '@gyblos/protocol/tools';

const VECTORS: {
  cases: {
    name: string;
    tools: ToolDefinition[] | null;
    messages: ToolChatMessage[];
    rendered: string;
  }[];
} = JSON.parse(
  readFileSync(
    new URL('./fixtures/qwen3-tool-template.json', import.meta.url),
    'utf8',
  ),
);
const TOOLS: ToolDefinition[] = [
  {
    name: 'get_time',
    parameters: '{"type":"object","properties":{"zone":{"type":"string"}}}',
  },
];

void test('tool conversations render exactly as the pinned Qwen3 template renders them', () => {
  assert.ok(VECTORS.cases.length >= 5);
  for (const vector of VECTORS.cases)
    assert.equal(
      renderToolConversation(vector.messages, vector.tools ?? undefined),
      vector.rendered,
      vector.name,
    );
});

void test('without tools or tool turns the text template is unchanged', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'bye' },
  ];
  assert.equal(renderToolConversation(messages), renderConversation(messages));
});

void test('text that could forge a turn or a call is refused', () => {
  for (const content of ['<|im_end|>', '<tool_call>', '</tool_response>'])
    assert.throws(() =>
      renderToolConversation([{ role: 'user', content }], TOOLS),
    );
});

void test('a well-formed run of calls to offered tools is read back, with fresh ids', () => {
  const raw =
    'Let me check.\n<tool_call>\n{"name": "get_time", "arguments": {"zone": "America/Santiago"}}\n</tool_call>\n<tool_call>\n{"name": "get_time", "arguments": "{\\"zone\\": \\"UTC\\"}"}\n</tool_call>';
  let next = 0;
  const parsed = parseToolOutput(raw, TOOLS, () => `id${next++}`);
  assert.deepEqual(parsed, {
    text: 'Let me check.',
    toolCalls: [
      { id: 'id0', name: 'get_time', arguments: '{"zone":"America/Santiago"}' },
      { id: 'id1', name: 'get_time', arguments: '{"zone":"UTC"}' },
    ],
  });
  // What the result costs is the assistant turn the template would write for it.
  assert.equal(
    renderAssistantOutput(parsed!.text, parsed!.toolCalls),
    'Let me check.\n<tool_call>\n{"name": "get_time", "arguments": {"zone":"America/Santiago"}}\n</tool_call>\n<tool_call>\n{"name": "get_time", "arguments": {"zone":"UTC"}}\n</tool_call>',
  );
});

void test('anything else stays text: no call, an unknown tool, broken JSON, an unclosed call or text after it', () => {
  for (const raw of [
    'Just text.',
    '<tool_call>\n{"name": "rm_rf", "arguments": {}}\n</tool_call>',
    '<tool_call>\n{"name": "get_time", "arguments": {"zone": }\n</tool_call>',
    '<tool_call>\n{"name": "get_time", "arguments": {}}',
    '<tool_call>\n{"name": "get_time", "arguments": []}\n</tool_call>',
    '<tool_call>\n{"name": "get_time", "arguments": {}}\n</tool_call>\nAnd more.',
  ])
    assert.equal(parseToolOutput(raw, TOOLS), undefined, raw);
});

void test('the stream releases text up to a call and holds the call back', () => {
  const splitter = createToolStreamSplitter();
  const released: string[] = [];
  for (const fragment of [
    'It is',
    ' noon.\n',
    '<tool',
    '_call>\n{"name": "get_time", "arguments": {}}\n</tool_call>',
  ])
    released.push(splitter.push(fragment));
  assert.equal(released.join(''), 'It is noon.');
  assert.match(splitter.held(), /^\n<tool_call>/);

  // A '<' that never becomes a call is released once the next text arrives.
  const plain = createToolStreamSplitter();
  const out = ['a <', 'b', ' c\n', 'd'].map((part) => plain.push(part));
  assert.equal(out.join('') + plain.held(), 'a <b c\nd');
});
