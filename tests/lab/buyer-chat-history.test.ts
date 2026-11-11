// Product terminal loop through owned HTTP and native Iroh; engines, identity bindings and finance are local fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { CHAT_COMMANDS } from '@gyblos/buyer/constants';
import {
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';
import type { ChatTokenizer, EngineInput } from '@gyblos/protocol/engine';

import { NATIVE_CAPABILITY } from '../support/native-runtime';
import { PAID_ACCEPTANCE } from '../support/paid-acceptance-constants';
import { sessionProductHost } from '../support/session-product-host';

const meter: ChatTokenizer = {
  input: (text) => text.length,
  chat: (messages) =>
    messages.reduce((sum, message) => sum + 2 + message.content.length, 0),
  count: (text) => [...text].length,
};

for (const pricing of [OFFER_PRICING_KINDS.FREE, OFFER_PRICING_KINDS.PAID])
  void test(
    `terminal confirmed history reaches the native ${pricing} seller and keeps conversation reset local`,
    { skip: NATIVE_CAPABILITY.transportSkip },
    async (t) => {
      let monotonic = performance.now();
      t.mock.method(performance, 'now', () => monotonic);
      const received: EngineInput[] = [];
      const host = await sessionProductHost(pricing, undefined, {
        meter,
        observe: (input) => received.push(input),
      });
      t.after(host.close);
      const lines = [
        'first question',
        'follow-up question',
        CHAT_COMMANDS.NEW,
        ...(pricing === OFFER_PRICING_KINDS.PAID ? ['fresh question'] : []),
        CHAT_COMMANDS.EXIT,
      ];
      let reads = 0;
      let output = '';
      await chatSession({
        ...host.buyer().chat,
        read: async () => {
          monotonic += 1000;
          return lines[reads++];
        },
        write: (text) => {
          output += text;
        },
      });
      assert.equal(reads, lines.length);
      assert.doesNotMatch(output, /Error:|No retry was made/);
      assert.deepEqual(
        received.map((input) => input.messages),
        [
          [{ role: FREE_CHAT_ROLES.USER, content: 'first question' }],
          [
            { role: FREE_CHAT_ROLES.USER, content: 'first question' },
            { role: FREE_CHAT_ROLES.ASSISTANT, content: PAID_ACCEPTANCE.text },
            { role: FREE_CHAT_ROLES.USER, content: 'follow-up question' },
          ],
          ...(pricing === OFFER_PRICING_KINDS.PAID
            ? [[{ role: FREE_CHAT_ROLES.USER, content: 'fresh question' }]]
            : []),
        ],
      );
      assert.equal(
        host.engine.attempts(),
        pricing === OFFER_PRICING_KINDS.PAID ? 3 : 2,
      );
      assert.deepEqual(
        host.finance.calls,
        pricing === OFFER_PRICING_KINDS.PAID ? ['deposit'] : [],
      );
      if (pricing === OFFER_PRICING_KINDS.PAID) {
        monotonic += 1000;
        const settled = await host.buyer().chat.session!.settle!();
        assert.ok(BigInt(settled!.chargedAtomic) > 0n);
        assert.equal(
          BigInt(settled!.chargedAtomic) + BigInt(settled!.refundedAtomic),
          100000n,
        );
        assert.deepEqual(host.finance.calls, ['deposit', 'refund']);
      }
    },
  );

void test(
  'terminal paid history cut ends before a queued reset can send another prompt',
  { skip: NATIVE_CAPABILITY.transportSkip },
  async (t) => {
    const received: EngineInput[] = [];
    const host = await sessionProductHost(OFFER_PRICING_KINDS.PAID, undefined, {
      meter,
      observe: (input) => received.push(input),
    });
    t.after(host.close);
    const lines = [
      'first question',
      'cut question',
      CHAT_COMMANDS.NEW,
      'must not send',
    ];
    let reads = 0;
    let output = '';
    await chatSession({
      ...host.buyer().chat,
      read: async () => {
        if (reads === 1) host.engine.interrupt();
        return lines[reads++];
      },
      write: (text) => {
        output += text;
      },
    });
    assert.equal(reads, 2);
    assert.equal(host.engine.attempts(), 2);
    const secondInput = received[1]?.messages;
    assert.ok(secondInput);
    assert.equal(secondInput.length, 3);
    assert.deepEqual(host.finance.calls, ['deposit']);
    assert.match(output, /No retry was made/);
  },
);
