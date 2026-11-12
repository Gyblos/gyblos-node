// Tool calling on the free channel: the conversation shape with tool turns, the optional wire fields only the
// free channel accepts, and the seller passing tools to an engine that serves them, refusing them otherwise
// and returning the model's calls with finish reason tool_calls. Synthetic engine and quotes only.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlQuote } from '@gyblos/core/control-quotes';
import {
  CONTROL_CODES,
  ENGINE_DONE_REASONS,
  FREE_EXECUTION_CODES,
} from '@gyblos/protocol/constants';
import { parseExecutionInput } from '@gyblos/protocol/execution-wire';
import {
  matchFreeExecutionResponse,
  parseFreeExecutionRequest,
  parseFreeExecutionResponse,
} from '@gyblos/protocol/free-execution';
import {
  isToolConversation,
  TOOL_CALLS_DONE,
  type ToolChatMessage,
  type ToolDefinition,
} from '@gyblos/protocol/tools';

import { controlFixture } from './support/control-fixture';
import {
  freeSellerFixture as fixture,
  freeSellerSignal as signal,
} from './support/free-seller';

const TOOLS: ToolDefinition[] = [
  {
    name: 'get_time',
    description: 'Current time in a time zone',
    parameters: '{"type":"object","properties":{"zone":{"type":"string"}}}',
  },
];
const CALL = { id: 'call_1', name: 'get_time', arguments: '{"zone":"UTC"}' };
const LOOP: ToolChatMessage[] = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'What time is it?' },
  { role: 'assistant', content: '', toolCalls: [CALL] },
  { role: 'tool', content: '12:00', toolCallId: 'call_1' },
];
const USAGE = {
  inputTokens: 4,
  outputTokens: 2,
  totalDurationNs: 0,
  loadDurationNs: 0,
  inputDurationNs: 0,
  outputDurationNs: 0,
};

void test('a tool conversation answers every call with one result before the model speaks again', () => {
  assert.equal(isToolConversation(LOOP), true);
  assert.equal(
    isToolConversation([
      ...LOOP,
      { role: 'assistant', content: 'It is noon.' },
      { role: 'user', content: 'Thanks' },
    ]),
    true,
  );
  for (const messages of [
    // A call left unanswered, a result for no call, a result twice, the model speaking after a call
    // before its result, and a leading assistant turn.
    LOOP.slice(0, 3),
    [LOOP[0]!, LOOP[1]!, LOOP[3]!],
    [...LOOP, LOOP[3]!],
    [...LOOP.slice(0, 3), { role: 'assistant' as const, content: 'x' }],
    LOOP.slice(2),
  ])
    assert.equal(isToolConversation(messages), false, JSON.stringify(messages));
});

void test('only the free channel takes tools; the paid and session channels keep their text-only input', async () => {
  const state = await fixture(
    { dailyTokenCap: 1000, perBuyerCap: 1000 },
    { tools: true },
  );
  const request = await state.request(1, undefined, {
    messages: LOOP,
    tools: TOOLS,
    toolChoice: 'auto',
  });
  const parsed = parseFreeExecutionRequest(request);
  assert.deepEqual(parsed.input.tools, TOOLS);
  assert.deepEqual(parsed.input.messages, LOOP);
  assert.throws(() =>
    parseExecutionInput(request.input, request.requestId, request.quote.offer),
  );
  // Malformed tools: arguments that are not a JSON object, a duplicate name, a choice naming no tool.
  for (const change of [
    { tools: [{ ...TOOLS[0]!, parameters: '[1]' }] },
    { tools: [TOOLS[0]!, TOOLS[0]!] },
    { tools: TOOLS, toolChoice: { name: 'other' } },
    { toolChoice: 'auto' as const },
  ])
    assert.throws(
      () =>
        parseFreeExecutionRequest({
          ...request,
          input: {
            ...request.input,
            tools: undefined,
            toolChoice: undefined,
            ...change,
          },
        }),
      JSON.stringify(change),
    );
});

void test('the seller passes tools to an engine that serves them and returns its calls', async () => {
  const state = await fixture(
    { dailyTokenCap: 1000, perBuyerCap: 1000 },
    { tools: true },
  );
  state.setRun(async () => ({
    text: '',
    toolCalls: [{ ...CALL, id: 'call_2' }],
    usage: USAGE,
    finishReason: TOOL_CALLS_DONE,
  }));
  const request = await state.request(1, undefined, {
    messages: LOOP.slice(0, 2),
    tools: TOOLS,
  });
  const response = await state.service.respond(
    request,
    request.quote.offer.buyerNodeId,
    signal(),
  );
  assert.ok(response.result, JSON.stringify(response.error));
  assert.equal(response.result.finishReason, TOOL_CALLS_DONE);
  assert.deepEqual(response.result.toolCalls, [{ ...CALL, id: 'call_2' }]);
  assert.deepEqual(state.lastInput()?.tools, TOOLS);
  // The buyer accepts it as the answer to its request.
  const result = await matchFreeExecutionResponse(response, request);
  assert.equal(result.toolCalls?.[0]?.name, 'get_time');
});

void test('an engine without tools refuses tools and tool turns as unsupported', async () => {
  const state = await fixture({ dailyTokenCap: 1000, perBuyerCap: 1000 });
  for (const [sequence, input] of [
    [1, { messages: LOOP.slice(0, 2), tools: TOOLS }],
    [2, { messages: LOOP }],
  ] as const) {
    const request = await state.request(sequence, undefined, input);
    const response = await state.service.respond(
      request,
      request.quote.offer.buyerNodeId,
      signal(),
    );
    assert.equal(response.error?.code, FREE_EXECUTION_CODES.UNSUPPORTED);
  }
  assert.equal(state.calls(), 0);
});

void test('a result calls tools exactly when its finish reason says so', () => {
  const base = {
    version: 4,
    requestId: '00'.repeat(16),
    requestDigest: '00'.repeat(32),
  };
  const result = {
    text: '',
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: TOOL_CALLS_DONE,
    toolCalls: [CALL],
  };
  assert.ok(parseFreeExecutionResponse({ ...base, result }).result);
  assert.throws(() =>
    parseFreeExecutionResponse({
      ...base,
      result: { ...result, finishReason: ENGINE_DONE_REASONS.STOP },
    }),
  );
  const { toolCalls: _calls, ...withoutCalls } = result;
  assert.throws(() =>
    parseFreeExecutionResponse({ ...base, result: withoutCalls }),
  );
});

void test('a buyer that will offer tools asks for them in the quote, and an offer without tools refuses it', async () => {
  const source = await controlFixture(true);
  const query = {
    ...source.request,
    params: { ...source.request.params, tools: true as const },
  };
  const quote = (tools: boolean) =>
    createControlQuote(
      query,
      {
        ...source.context,
        models: source.context.models.map((model) => ({ ...model, tools })),
        remoteNodeId: source.request.params.buyerNodeId,
      },
      source.ownerSigner,
    );
  await assert.rejects(quote(false), { code: CONTROL_CODES.TOOLS });
  // The signed offer itself is unchanged: buyers that never ask for tools read it as before.
  const offer = (await quote(true)).offer;
  assert.equal(Object.hasOwn(offer, 'tools'), false);
});
