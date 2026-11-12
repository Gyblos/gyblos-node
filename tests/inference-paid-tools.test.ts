// Synthetic reusable financial ports and actual loopback transport prove tool-aware usage before approval.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ENGINE_DONE_REASONS, ENGINE_KINDS } from '@gyblos/protocol/constants';
import type { ChatTokenizer, EngineResult } from '@gyblos/protocol/engine';
import type { InferenceBuildInput } from '@gyblos/protocol/inference';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { SESSION_CODES } from '@gyblos/protocol/payment-session';
import {
  TELEMETRY_EVENTS,
  type TelemetryEvent,
} from '@gyblos/protocol/telemetry';
import { TOOL_CALLS_DONE, TOOL_CHOICES } from '@gyblos/protocol/tools';

import { batchConversation } from './support/batch-conversation';

const CALL = { id: 'synthetic-call', name: 'get_time', arguments: '{}' };
const INPUT: InferenceBuildInput = {
  messages: [{ role: 'user', content: 'synthetic' }],
  maxTokens: 10,
  tools: [{ name: 'get_time', parameters: '{"type":"object"}' }],
  toolChoice: TOOL_CHOICES.AUTO,
};
const METER: ChatTokenizer = {
  input: () => 1,
  count: (text) => text.length,
  chat: (_messages, tools) => {
    assert.deepEqual(tools, INPUT.tools);
    return 20;
  },
  output: (_text, calls) => {
    assert.deepEqual(calls, [CALL]);
    return 7;
  },
};
const OUTPUT: EngineResult = {
  text: '',
  toolCalls: [CALL],
  finishReason: TOOL_CALLS_DONE,
  usage: {
    inputTokens: 20,
    outputTokens: 7,
    totalDurationNs: 0,
    loadDurationNs: 0,
    inputDurationNs: 0,
    outputDurationNs: 0,
  },
};
void test('paid tool-only turns preserve tools and history and reuse one deposit with verified cumulative usage', async (t) => {
  const events: TelemetryEvent[] = [];
  const f = await batchConversation(METER, {
    sink: {
      emit: (event) => {
        events.push(event);
      },
      flush: async () => {},
      close: async () => ({
        emitted: events.length,
        dropped: 0,
        failed: false,
      }),
    },
    engineKind: () => ENGINE_KINDS.OLLAMA,
  });
  t.after(f.close);
  f.offers.live.engine.supportsTools = () => true;
  f.offers.generate(async () => OUTPUT);
  const first = await f
    .buyer()
    .execute(await f.quote(1), INPUT, new AbortController().signal);
  assert.equal(first.approval.approvedAtomic, '27');
  assert.equal(first.value.toolCalls?.[0]?.name, CALL.name);
  assert.deepEqual(f.generated[0]?.tools, INPUT.tools);
  const next: InferenceBuildInput = {
    ...INPUT,
    messages: [
      ...INPUT.messages,
      { role: 'assistant', content: '', toolCalls: [CALL] },
      { role: 'tool', content: '12:00', toolCallId: CALL.id },
    ],
  };
  f.offers.generate(async () => ({
    ...OUTPUT,
    text: 'ok!',
    toolCalls: undefined,
    finishReason: ENGINE_DONE_REASONS.STOP,
  }));
  const second = await f
    .buyer()
    .execute(await f.quote(2), next, new AbortController().signal);
  assert.deepEqual(f.generated[1]?.messages, next.messages);
  assert.equal(second.approval.cumulativeAtomic, '50');
  assert.deepEqual(f.rig.calls, ['deposit']);
  assert.equal(
    events.filter((event) => event.type === TELEMETRY_EVENTS.COMPLETED).length,
    2,
  );
  assert.equal(
    events.filter((event) => event.type === TELEMETRY_EVENTS.CHARGED).length,
    0,
    'approval is not settlement',
  );
});
void test('a wrong returned tool cannot create a paid cumulative voucher', async (t) => {
  const f = await batchConversation(METER);
  t.after(f.close);
  f.offers.live.engine.supportsTools = () => true;
  f.offers.generate(async () => ({
    ...OUTPUT,
    toolCalls: [{ ...CALL, name: 'unoffered' }],
  }));
  const approve = t.mock.method(f.rig.buyer, 'approve');
  await assert.rejects(
    f.buyer().execute(await f.quote(1), INPUT, new AbortController().signal),
  );
  assert.equal(approve.mock.callCount(), 0);
  assert.equal(f.generated.length, 1);
});
void test('tool usage altered in transport cannot produce an approval', async (t) => {
  const f = await batchConversation(METER);
  t.after(f.close);
  f.offers.live.engine.supportsTools = () => true;
  f.offers.generate(async () => OUTPUT);
  f.alterUsage();
  const approve = t.mock.method(f.rig.buyer, 'approve');
  await assert.rejects(
    f.buyer().execute(await f.quote(1), INPUT, new AbortController().signal),
    { code: SESSION_CODES.UNVERIFIED },
  );
  assert.equal(approve.mock.callCount(), 0);
});
void test('a tool input without an output renderer fails before any financial construction', async (t) => {
  const { output: _output, ...missing } = METER;
  const f = await batchConversation(missing);
  t.after(f.close);
  await assert.rejects(
    f.buyer().execute(await f.quote(1), INPUT, new AbortController().signal),
  );
  assert.equal(f.constructions(), 0);
  assert.deepEqual(f.rig.calls, []);
  assert.equal(f.generated.length, 0);
});

void test('tool-result history without definitions also requires an output renderer before finance', async (t) => {
  const { output: _output, ...missing } = METER;
  const f = await batchConversation({ ...missing, chat: () => 20 });
  t.after(f.close);
  const input: InferenceBuildInput = {
    messages: [
      ...INPUT.messages,
      { role: 'assistant', content: '', toolCalls: [CALL] },
      { role: 'tool', content: '12:00', toolCallId: CALL.id },
    ],
    maxTokens: 10,
  };
  await assert.rejects(
    f.buyer().execute(await f.quote(1), input, new AbortController().signal),
  );
  assert.equal(f.constructions(), 0);
  assert.deepEqual(f.rig.calls, []);
});
void test('canonical tool output beyond the quoted token limit returns LIMIT without approval', async (t) => {
  const f = await batchConversation({ ...METER, output: () => 11 });
  t.after(f.close);
  f.offers.live.engine.supportsTools = () => true;
  f.offers.generate(async () => OUTPUT);
  const approve = t.mock.method(f.rig.buyer, 'approve');
  await assert.rejects(
    f.buyer().execute(await f.quote(1), INPUT, new AbortController().signal),
    { code: PAID_EXECUTION_CODES.LIMIT },
  );
  assert.equal(approve.mock.callCount(), 0);
});

void test('a lost tool approval ACK recovers the original voucher without repeating the prompt', async (t) => {
  const f = await batchConversation(METER);
  t.after(f.close);
  f.offers.live.engine.supportsTools = () => true;
  f.offers.generate(async () => OUTPUT);
  f.loseAck();
  await assert.rejects(
    f.buyer().execute(await f.quote(1), INPUT, new AbortController().signal),
  );
  await f.restart();
  assert.equal(await f.buyer().unresolved(), false);
  assert.equal(f.generated.length, 1);
  assert.deepEqual(f.rig.calls, ['deposit']);
  assert.equal((await f.inspect())?.snapshot.cumulativeAtomic, '27');
});
void test('cancelling before the tool terminal produces no approval, settlement or retry', async (t) => {
  const f = await batchConversation(METER);
  t.after(f.close);
  f.offers.live.engine.supportsTools = () => true;
  let start: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  f.offers.generate(async (input) => {
    start();
    await new Promise<void>((_resolve, reject) => {
      const stop = () => reject(input.signal?.reason);
      input.signal?.addEventListener('abort', stop, { once: true });
      if (input.signal?.aborted) stop();
    });
    return OUTPUT;
  });
  const approve = t.mock.method(f.rig.buyer, 'approve');
  const controller = new AbortController();
  const pending = f.buyer().execute(await f.quote(1), INPUT, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(approve.mock.callCount(), 0);
  assert.equal(f.generated.length, 1);
  assert.deepEqual(f.rig.calls, ['deposit']);
});
