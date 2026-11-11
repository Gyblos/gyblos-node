// Terminal history uses synthetic owned-loopback replies; partial answers never become another request.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { BUYER_EXECUTION_FIELD, PAID_BUYER } from '@gyblos/buyer/constants';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import { ENGINE_DONE_REASONS, FREE_CHAT_ROLES, OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

function response(text: string, paid = false, cumulative = '40') {
  const delta = { choices: [{ delta: { content: text }, finish_reason: null }] };
  const terminal = {
    choices: [{ delta: {}, finish_reason: ENGINE_DONE_REASONS.STOP }],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
    ...(paid ? {
      [BUYER_EXECUTION_FIELD]: OFFER_PRICING_KINDS.PAID,
      [PAID_BUYER.paymentField]: {
        verdict: SESSION_VERDICTS.APPROVED,
        chargedAtomic: null,
        refundedAtomic: null,
        session: { approvedAtomic: '40', cumulativeAtomic: cumulative, depositAtomic: '1000' },
      },
    } : {}),
  };
  return new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function input(lines: string[]) {
  let reads = 0;
  return { read: async () => lines[reads++], reads: () => reads };
}

void test('chat sends confirmed user and assistant turns with the next question', async () => {
  const requests: unknown[] = [];
  const read = input(['first question', 'follow-up question', '/exit']);
  await chatSession({
    model: 'synthetic', maxTokens: 8, maxAtomic: '0',
    ...read, write() {},
    request: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)).messages);
      return response(requests.length === 1 ? 'first answer' : 'next answer');
    },
  });
  assert.deepEqual(requests, [
    [{ role: FREE_CHAT_ROLES.USER, content: 'first question' }],
    [
      { role: FREE_CHAT_ROLES.USER, content: 'first question' },
      { role: FREE_CHAT_ROLES.ASSISTANT, content: 'first answer' },
      { role: FREE_CHAT_ROLES.USER, content: 'follow-up question' },
    ],
  ]);
});

void test('new conversation clears only history, retaining approved totals until explicit settlement', async () => {
  const requests: unknown[] = [];
  const read = input(['first question', '/new', 'fresh question', '/settle']);
  let settled = 0;
  let output = '';
  await chatSession({
    model: 'synthetic', maxTokens: 8, maxAtomic: '100', automatic: true,
    ...read, write: (text) => { output += text; },
    session: {
      depositAtomic: '1000', lifetimeMs: 3600000, withdrawDelaySeconds: 900,
      settle: async () => {
        settled++;
        return { chargedAtomic: '80', refundedAtomic: '920' };
      },
    },
    request: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)).messages);
      return response('confirmed answer', true, String(requests.length * 40));
    },
  });
  assert.deepEqual(requests, [
    [{ role: FREE_CHAT_ROLES.USER, content: 'first question' }],
    [{ role: FREE_CHAT_ROLES.USER, content: 'fresh question' }],
  ]);
  assert.equal(settled, 1);
  assert.match(output, /cumulative: 80/);
  assert.match(output, /finalized charge 80; refunded 920/);
  assert.match(output, /\/new/);
  assert.doesNotMatch(output, /Each question is independent/);
});

void test('a locally rejected prompt does not discard or enter the confirmed history', async () => {
  const requests: unknown[] = [];
  const read = input(['first', 'x'.repeat(64001), 'follow-up', '/exit']);
  await chatSession({
    model: 'synthetic', maxTokens: 8, maxAtomic: '0',
    ...read, write() {},
    request: async (_url, options) => {
      requests.push(JSON.parse(String(options?.body)).messages);
      return response('confirmed');
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [
    { role: FREE_CHAT_ROLES.USER, content: 'first' },
    { role: FREE_CHAT_ROLES.ASSISTANT, content: 'confirmed' },
    { role: FREE_CHAT_ROLES.USER, content: 'follow-up' },
  ]);
});

void test('a mid-answer cut stops before a queued new conversation or follow-up can resend content', async () => {
  const read = input(['first', 'second', '/new', 'must not send']);
  let requests = 0;
  let output = '';
  await chatSession({
    model: 'synthetic', maxTokens: 8, maxAtomic: '0',
    ...read, write: (text) => { output += text; },
    request: async () => {
      requests++;
      if (requests === 1) return response('confirmed');
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  assert.equal(requests, 2);
  assert.equal(read.reads(), 2);
  assert.match(output, /partial/);
  assert.match(output, /No retry was made/);
});
