// Buyer terminal labels use synthetic payment summaries and never contact a chain.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { PAID_VERDICTS } from '@gyblos/buyer/constants';

void test('a pending seller claim is not presented as a confirmed charge', async () => {
  const output: string[] = [];
  await chatSession({
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '100',
    request: async () => new Response(),
    read: async () => 'synthetic prompt',
    write: (text) => output.push(text),
    turn: async () => ({
      status: 'uncertain',
      payment: {
        verdict: PAID_VERDICTS.PENDING,
        charged: '17',
        refunded: null,
      },
    }),
  });
  const text = output.join('');
  assert.match(text, /reported.*17/i);
  assert.match(text, /not confirmed/i);
  assert.doesNotMatch(text, /charged:\s*17/i);
});

void test('a cut with a verified settlement shows the confirmed charge and does not retry', async () => {
  const output: string[] = [];
  let turns = 0;
  await chatSession({
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '100',
    request: async () => new Response(),
    read: async () => 'synthetic prompt',
    write: (text) => output.push(text),
    turn: async () => {
      turns++;
      return {
        status: 'uncertain',
        payment: {
          verdict: PAID_VERDICTS.SETTLED,
          charged: '7',
          refunded: '93',
        },
      };
    },
  });
  assert.equal(turns, 1);
  assert.match(output.join(''), /charged:\s*7/);
  assert.match(output.join(''), /No retry was made/);
});
