// Terminal history uses synthetic owned-loopback replies; partial answers never become another request.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { BUYER_EXECUTION_FIELD, PAID_BUYER } from '@gyblos/buyer/constants';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { SESSION_VERDICTS } from '@gyblos/node/constants';
import {
  ENGINE_DONE_REASONS,
  FREE_CHAT_ROLES,
  OFFER_PRICING_KINDS,
} from '@gyblos/protocol/constants';

function response(text: string, paid = false, cumulative = '40') {
  const delta = {
    choices: [{ delta: { content: text }, finish_reason: null }],
  };
  const terminal = {
    choices: [{ delta: {}, finish_reason: ENGINE_DONE_REASONS.STOP }],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
    ...(paid
      ? {
          [BUYER_EXECUTION_FIELD]: OFFER_PRICING_KINDS.PAID,
          [PAID_BUYER.paymentField]: {
            verdict: SESSION_VERDICTS.APPROVED,
            chargedAtomic: null,
            refundedAtomic: null,
            session: {
              approvedAtomic: '40',
              cumulativeAtomic: cumulative,
              depositAtomic: '1000',
            },
          },
        }
      : {}),
  };
  return new Response(
    `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`,
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}
function input(lines: string[]) {
  let reads = 0;
  return { read: async () => lines[reads++], reads: () => reads };
}

function submittedMessages(options: RequestInit | undefined): unknown {
  const body: unknown = JSON.parse(String(options?.body));
  assert.ok(body && typeof body === 'object' && 'messages' in body);
  return body.messages;
}

void test('chat sends confirmed user and assistant turns with the next question', async () => {
  const requests: unknown[] = [];
  const read = input(['first question', 'follow-up question', '/exit']);
  await chatSession({
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '0',
    ...read,
    write() {},
    request: async (_url, options) => {
      requests.push(submittedMessages(options));
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
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '100',
    automatic: true,
    ...read,
    write: (text) => {
      output += text;
    },
    session: {
      depositAtomic: '1000',
      lifetimeMs: 3600000,
      withdrawDelaySeconds: 900,
      settle: async () => {
        settled++;
        return { chargedAtomic: '80', refundedAtomic: '920' };
      },
    },
    request: async (_url, options) => {
      requests.push(submittedMessages(options));
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
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '0',
    ...read,
    write() {},
    request: async (_url, options) => {
      requests.push(submittedMessages(options));
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
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '0',
    ...read,
    write: (text) => {
      output += text;
    },
    request: async () => {
      requests++;
      if (requests === 1) return response('confirmed');
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] })}\n\n`,
        {
          headers: { 'content-type': 'text/event-stream' },
        },
      );
    },
  });
  assert.equal(requests, 2);
  assert.equal(read.reads(), 2);
  assert.match(output, /partial/);
  assert.match(output, /No retry was made/);
});

void test('a full conversation refuses the next prompt locally until new clears it, without trimming', async () => {
  const requests: unknown[] = [];
  const read = input(['first', 'q'.repeat(2000), '/new', 'fresh', '/exit']);
  let output = '';
  await chatSession({
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '0',
    ...read,
    write: (text) => {
      if (text.length < 1000) output += text;
    },
    request: async (_url, options) => {
      requests.push(submittedMessages(options));
      return response(
        requests.length === 1 ? 'a'.repeat(63000) : 'fresh answer',
      );
    },
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [
    { role: FREE_CHAT_ROLES.USER, content: 'fresh' },
  ]);
  assert.match(output, /Question rejected before sending/);
});

void test('confirmed history is isolated between terminal sessions', async () => {
  const requests: unknown[] = [];
  for (const prompt of ['one session', 'another session']) {
    const read = input([prompt, '/exit']);
    await chatSession({
      model: 'synthetic',
      maxTokens: 8,
      maxAtomic: '0',
      ...read,
      write() {},
      request: async (_url, options) => {
        requests.push(submittedMessages(options));
        return response('answer');
      },
    });
  }
  assert.deepEqual(requests[1], [
    { role: FREE_CHAT_ROLES.USER, content: 'another session' },
  ]);
});

void test('terminal history and new conversation traverse the product HTTP parser with a fake engine', async (t) => {
  const messages: unknown[] = [];
  const host = await startFreeBuyerHttp(
    async () => assert.fail('streaming only'),
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 64,
    },
    {
      port: 0,
      stream: async (input, _signal, emit) => {
        messages.push(input.messages);
        await emit('local answer');
        return {
          text: 'local answer',
          finishReason: ENGINE_DONE_REASONS.STOP,
          usage: { inputTokens: input.messages.length, outputTokens: 12 },
        };
      },
    },
  );
  t.after(host.close);
  const read = input(['first', 'next', '/new', 'fresh', '/exit']);
  await chatSession({
    model: 'synthetic',
    maxTokens: 64,
    maxAtomic: '0',
    ...read,
    write() {},
    request: async (_url, options) => fetch(host.url, options),
  });
  assert.deepEqual(messages, [
    [{ role: FREE_CHAT_ROLES.USER, content: 'first' }],
    [
      { role: FREE_CHAT_ROLES.USER, content: 'first' },
      { role: FREE_CHAT_ROLES.ASSISTANT, content: 'local answer' },
      { role: FREE_CHAT_ROLES.USER, content: 'next' },
    ],
    [{ role: FREE_CHAT_ROLES.USER, content: 'fresh' }],
  ]);
});
