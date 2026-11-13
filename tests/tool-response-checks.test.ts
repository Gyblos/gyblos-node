// What a buyer accepts back when tools are involved, whatever the seller's adapter checked: calls only to tools
// the request offered, never when it offered none or chose none, and only the named tool for a named
// choice, both for a whole response and a stream's terminal. And the Anthropic engine bounding the content
// block indexes a provider streams before it stores anything. Synthetic sellers and providers only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAnthropicEngine } from '@gyblos/engine-anthropic/engine';
import {
  FREE_EXECUTION,
  FREE_EXECUTION_CODES,
  FREE_STREAM,
} from '@gyblos/protocol/constants';
import { matchFreeExecutionResponse } from '@gyblos/protocol/free-execution';
import { createFreeStreamVerifier } from '@gyblos/protocol/free-stream';
import {
  TOOL_CALLS_DONE,
  type ToolChoice,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import {
  freeSellerFixture as fixture,
  freeSellerSignal as signal,
} from './support/free-seller';

const TOOLS: ToolDefinition[] = [
  { name: 'get_time', parameters: '{"type":"object","properties":{}}' },
  { name: 'get_date', parameters: '{"type":"object","properties":{}}' },
];
const USAGE = {
  inputTokens: 4,
  outputTokens: 2,
  totalDurationNs: 0,
  loadDurationNs: 0,
  inputDurationNs: 0,
  outputDurationNs: 0,
};

// A seller whose engine returns a call to `name`, answering a request with these tools and choice.
async function called(
  sequence: number,
  name: string,
  input: { tools?: ToolDefinition[]; toolChoice?: ToolChoice },
  invalid = false,
) {
  const state = await fixture(
    { dailyTokenCap: 1000, perBuyerCap: 1000 },
    { tools: true },
  );
  state.setRun(async () => ({
    text: '',
    toolCalls: [{ id: 'call_1', name, arguments: '{}' }],
    usage: USAGE,
    finishReason: TOOL_CALLS_DONE,
  }));
  const request = await state.request(sequence, undefined, {
    messages: [{ role: 'user', content: 'time?' }],
    ...input,
  });
  const actual = await state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    signal(),
  );
  if (invalid)
    assert.equal(
      actual.error?.code,
      FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    );
  else assert.ok(actual.result);
  // Supply a malicious peer terminal directly: the common seller now refuses these too.
  const response = {
    version: actual.version,
    requestId: actual.requestId,
    requestDigest: actual.requestDigest,
    result: {
      text: '',
      toolCalls: [{ id: 'call_1', name, arguments: '{}' }],
      usage: { inputTokens: 4, outputTokens: 2 },
      finishReason: TOOL_CALLS_DONE,
    },
  };
  return { request, response };
}

const REFUSED = [
  ['a tool the request did not offer', 'unoffered_tool', { tools: TOOLS }],
  ['a request that offered no tools', 'get_time', {}],
  ['a choice of none', 'get_time', { tools: TOOLS, toolChoice: 'none' }],
  [
    'a named choice of another tool',
    'get_date',
    { tools: TOOLS, toolChoice: { name: 'get_time' } },
  ],
] as const;

void test('the buyer refuses calls the request did not allow, and accepts the ones it did', async () => {
  let sequence = 1;
  for (const [label, name, input] of REFUSED) {
    const { request, response } = await called(sequence++, name, input, true);
    await assert.rejects(
      matchFreeExecutionResponse(response, request),
      { code: FREE_EXECUTION_CODES.INVALID },
      label,
    );
  }
  for (const input of [
    { tools: TOOLS },
    { tools: TOOLS, toolChoice: 'required' as const },
    { tools: TOOLS, toolChoice: { name: 'get_date' } },
  ]) {
    const { request, response } = await called(sequence++, 'get_date', input);
    const result = await matchFreeExecutionResponse(response, request);
    assert.equal(result.toolCalls?.[0]?.name, 'get_date');
  }
});

void test('a stream terminal with a call the request did not allow is refused', async () => {
  let sequence = 20;
  for (const [label, name, input] of REFUSED) {
    const { request, response } = await called(sequence++, name, input, true);
    const verifier = await createFreeStreamVerifier(request);
    await assert.rejects(
      verifier.accept({
        version: FREE_EXECUTION.version,
        requestId: response.requestId,
        requestDigest: response.requestDigest,
        sequence: 0,
        type: FREE_STREAM.events.TERMINAL,
        response,
      }),
      { code: FREE_EXECUTION_CODES.INVALID },
      label,
    );
  }
});

void test('the Anthropic engine refuses a content block index far beyond any answer, at once', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    {
      type: 'content_block_start',
      index: 50_000_000,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'get_time',
        input: {},
      },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ];
  const engine = createAnthropicEngine(
    {
      base: 'https://api.example',
      model: 'm',
      contextTokens: 8192,
      apiKey: 'synthetic',
    },
    async () =>
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
  );
  const started = performance.now();
  await assert.rejects(
    engine.generate({
      messages: [{ role: 'user', content: 'time?' }],
      tools: TOOLS,
      maxTokens: 10,
    }),
  );
  assert.ok(
    performance.now() - started < 200,
    'refused without filling a huge array',
  );
});
