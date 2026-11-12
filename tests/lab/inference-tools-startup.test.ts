// Both prices use the same HTTP conversation and native Iroh execution; engines and finance are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isJsonFields } from '@gyblos/core/engine-provider';
import {
  ENGINE_DONE_REASONS,
  OFFER_PRICING_KINDS,
  P2P_ROLES,
} from '@gyblos/protocol/constants';
import type { ChatTokenizer, EngineInput } from '@gyblos/protocol/engine';
import {
  TELEMETRY_EVENTS,
  type TelemetryEvent,
} from '@gyblos/protocol/telemetry';
import { TOOL_CALLS_DONE } from '@gyblos/protocol/tools';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { sessionProductHost } from '../support/session-product-host';

const CALL = { id: 'synthetic_call', name: 'get_time', arguments: '{}' };
const TOOLS = [
  {
    type: 'function',
    function: { name: 'get_time', parameters: { type: 'object' } },
  },
];
const METER: ChatTokenizer = {
  input: () => 20,
  chat: (_messages, tools) => {
    assert.equal(tools?.[0]?.name, 'get_time');
    return 20;
  },
  count: (text) => text.length,
  output: () => 7,
};
for (const pricing of Object.values(OFFER_PRICING_KINDS))
  for (const stream of [false, true])
    void test(
      `native common HTTP tools: ${pricing}, stream=${stream}`,
      { skip: NATIVE_CAPABILITY.transportSkip },
      async (t) => {
        const events: TelemetryEvent[] = [];
        const inputs: EngineInput[] = [];
        const host = await sessionProductHost(pricing, undefined, {
          meter: METER,
          observe: (input) => {
            inputs.push(input);
          },
          telemetry: {
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
          generate: async (input) => {
            const followup = input.messages?.some(
              (message) => message.role === 'tool',
            );
            if (followup) await input.onText?.('ok!');
            return {
              text: followup ? 'ok!' : '',
              ...(followup ? {} : { toolCalls: [CALL] }),
              finishReason: followup
                ? ENGINE_DONE_REASONS.STOP
                : TOOL_CALLS_DONE,
              usage: {
                inputTokens: 20,
                outputTokens: followup ? 3 : 7,
                totalDurationNs: 0,
                loadDurationNs: 0,
                inputDurationNs: 0,
                outputDurationNs: 0,
              },
            };
          },
        });
        t.after(host.close);
        const messages = [{ role: 'user', content: 'synthetic' }];
        for (const followup of [false, true]) {
          const turns = followup
            ? [
                ...messages,
                {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: CALL.id,
                      type: 'function',
                      function: { name: CALL.name, arguments: CALL.arguments },
                    },
                  ],
                },
                { role: 'tool', tool_call_id: CALL.id, content: '12:00' },
              ]
            : messages;
          const response = await host.buyer().chat.request('ignored', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: host.buyer().chat.model,
              messages: turns,
              tools: TOOLS,
              max_tokens: 10,
              stream,
            }),
          });
          const body = await response.text();
          assert.equal(response.status, 200, body);
          if (stream) {
            assert.match(body, /\[DONE\]/);
            assert.match(body, followup ? /ok!/ : /get_time/);
          } else {
            const value: unknown = JSON.parse(body);
            assert.ok(isJsonFields(value));
            assert.ok(Array.isArray(value.choices));
            assert.match(body, followup ? /ok!/ : /get_time/);
          }
        }
        assert.equal(inputs.length, 2);
        assert.equal(inputs[1]?.messages?.at(-1)?.role, 'tool');
        for (const role of Object.values(P2P_ROLES))
          assert.equal(
            events.filter(
              (event) =>
                event.role === role &&
                event.type === TELEMETRY_EVENTS.COMPLETED,
            ).length,
            2,
          );
        assert.equal(
          events.filter((event) => event.type === TELEMETRY_EVENTS.CHARGED)
            .length,
          0,
        );
        for (const role of Object.values(P2P_ROLES))
          assert.equal(
            events.filter(
              (event) =>
                event.role === role &&
                event.type === TELEMETRY_EVENTS.FIRST_TOKEN,
            ).length,
            2,
          );
        assert.ok(!JSON.stringify(events).includes('get_time'));
        assert.ok(!JSON.stringify(events).includes('12:00'));
        if (pricing === OFFER_PRICING_KINDS.FREE) {
          assert.equal(host.finance.buyerCreates(), 0);
          assert.deepEqual(host.finance.calls, []);
        } else {
          assert.deepEqual(host.finance.calls, ['deposit']);
          assert.equal(host.finance.approvals(), 2);
        }
      },
    );
