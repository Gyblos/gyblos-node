// Reusable-session accounting is approved usage, never a fabricated on-chain settlement.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { chatTurn } from '@gyblos/buyer/chat-cli-turn';
import { BUYER_EXECUTION_FIELD, PAID_BUYER } from '@gyblos/buyer/constants';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

void test('chat accepts verified session approval as a complete answer without claiming settlement', async () => {
  const payment = {
    verdict: SESSION_VERDICTS.APPROVED,
    chargedAtomic: null,
    refundedAtomic: null,
    session: {
      approvedAtomic: '40',
      cumulativeAtomic: '80',
      depositAtomic: '1000',
    },
  };
  const body = {
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
    [BUYER_EXECUTION_FIELD]: OFFER_PRICING_KINDS.PAID,
    [PAID_BUYER.paymentField]: payment,
  };
  const response = new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok!' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const result = await chatTurn(
    {
      model: 'synthetic',
      maxTokens: 10,
      prompt: 'synthetic',
      automatic: true,
      write() {},
    },
    async () => response,
  );
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.payment?.session, payment.session);
  assert.equal(result.payment?.charged, null);
});
void test('chat displays approved totals and permits the next question within the session', async () => {
  let questions = 0;
  let output = '';
  await chatSession({
    model: 'synthetic',
    maxTokens: 10,
    maxAtomic: '200',
    automatic: true,
    session: {
      depositAtomic: '1000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
    },
    request: async () => assert.fail('synthetic turn supplied'),
    read: async () => (++questions <= 2 ? 'synthetic' : '/exit'),
    write: (text) => {
      output += text;
    },
    turn: async () => ({
      status: 'complete',
      payment: {
        verdict: SESSION_VERDICTS.APPROVED,
        charged: null,
        refunded: null,
        session: {
          approvedAtomic: '40',
          cumulativeAtomic: String(questions * 40),
          depositAtomic: '1000',
        },
      },
    }),
  });
  assert.equal(questions, 3);
  assert.match(output, /Session deposit limit: 1000/);
  assert.match(output, /Approved this question: 40/);
  assert.match(output, /cumulative: 80/);
  assert.doesNotMatch(
    output,
    /Maximum deposit: 200.*per request|Payment: settled/,
  );
});
