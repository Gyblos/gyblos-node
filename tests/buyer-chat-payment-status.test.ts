// Buyer terminal labels use synthetic payment summaries and never contact a chain.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatSession, runOwnedChat } from '@gyblos/buyer/chat-cli';
import { chatTurn } from '@gyblos/buyer/chat-cli-turn';
import { PAID_VERDICTS } from '@gyblos/buyer/constants';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { classifyPaidError, paidChat } from '@gyblos/buyer/paid-http';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import { PaidClientError } from '@gyblos/transport-iroh/paid-client';

import { setup } from './support/buyer-paid';

const DIGEST = 'ab'.repeat(32);
const DELTA = JSON.stringify({
  gyblos_request_digest: DIGEST,
  choices: [{ delta: { content: 'synthetic' }, finish_reason: null }],
});

void test('an interrupted stream keeps its validated request digest without retry', async () => {
  let calls = 0;
  const result = await chatTurn(
    {
      model: 'synthetic',
      maxTokens: 8,
      prompt: 'synthetic',
      paid: true,
      write: () => {},
    },
    async () => {
      calls++;
      return new Response(`data: ${DELTA}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.requestDigest, DIGEST);
});

void test('after a cut the chat inspects only its own digest after stopping the buyer', async () => {
  const output: string[] = [];
  let calls = 0;
  let closed = false;
  let inspections = 0;
  await runOwnedChat(
    async () => ({
      chat: {
        model: 'synthetic',
        maxTokens: 8,
        maxAtomic: '100',
        request: async () => {
          calls++;
          return new Response(`data: ${DELTA}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      },
      close: async () => {
        closed = true;
      },
    }),
    async () => 'synthetic prompt',
    (text) => output.push(text),
    undefined,
    async (digest: string) => {
      inspections++;
      assert.equal(closed, true);
      assert.equal(digest, DIGEST);
      return { chargedAtomic: '7', refundedAtomic: '93' };
    },
  );
  assert.equal(calls, 1);
  assert.equal(inspections, 1);
  assert.match(output.join(''), /RPC.*finalized.*7/i);
});

void test('changed or invalid digests are not used to inspect another payment', async () => {
  for (const altered of ['cd'.repeat(32), 'INVALID']) {
    const bad = JSON.stringify({
      gyblos_request_digest: altered,
      choices: [{ delta: { content: 'synthetic' }, finish_reason: null }],
    });
    const result = await chatTurn(
      {
        model: 'synthetic',
        maxTokens: 8,
        prompt: 'synthetic',
        paid: true,
        write: () => {},
      },
      async () =>
        new Response(`data: ${DELTA}\n\ndata: ${bad}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    assert.equal(result.status, 'uncertain');
    assert.equal(result.requestDigest, undefined);
  }
});

void test('a cut before the first complete digest cannot trigger an inspection', async () => {
  let inspections = 0;
  let calls = 0;
  const output: string[] = [];
  await runOwnedChat(
    async () => ({
      chat: {
        model: 'synthetic',
        maxTokens: 8,
        maxAtomic: '100',
        request: async () => {
          calls++;
          return new Response(`data: ${DELTA.slice(0, 30)}`, {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      },
      close: async () => {},
    }),
    async () => 'synthetic prompt',
    (text) => output.push(text),
    undefined,
    async () => {
      inspections++;
      return { chargedAtomic: '0', refundedAtomic: '100' };
    },
  );
  assert.equal(calls, 1);
  assert.equal(inspections, 0);
  assert.doesNotMatch(output.join(''), /finalized charge/);
});

void test('an unavailable inspection remains pending and never retries the prompt', async () => {
  for (const fail of [false, true]) {
    const output: string[] = [];
    let calls = 0;
    await runOwnedChat(
      async () => ({
        chat: {
          model: 'synthetic',
          maxTokens: 8,
          maxAtomic: '100',
          request: async () => {
            calls++;
            return new Response(`data: ${DELTA}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            });
          },
        },
        close: async () => {},
      }),
      async () => 'synthetic prompt',
      (text) => output.push(text),
      undefined,
      async () => {
        if (fail) throw new Error('private RPC details');
        return undefined;
      },
    );
    assert.equal(calls, 1);
    assert.match(output.join(''), /pending|could not be verified/i);
    assert.doesNotMatch(
      output.join(''),
      /private RPC details|finalized charge/i,
    );
  }
});

void test('a user cancellation after a valid delta still performs one bounded read-only inspection', async () => {
  const abort = new AbortController();
  const output: string[] = [];
  let calls = 0;
  let inspections = 0;
  await runOwnedChat(
    async () => ({
      chat: {
        model: 'synthetic',
        maxTokens: 8,
        maxAtomic: '100',
        request: async () => {
          calls++;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${DELTA}\n\n`),
                );
                setTimeout(() => {
                  abort.abort();
                  controller.error(new Error('cancelled'));
                }, 10);
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
      close: async () => {},
    }),
    async () => 'synthetic prompt',
    (text) => output.push(text),
    abort.signal,
    async (digest) => {
      inspections++;
      assert.equal(digest, DIGEST);
      return undefined;
    },
  );
  assert.equal(calls, 1);
  assert.equal(inspections, 1);
  assert.match(output.join(''), /pending|could not be verified/i);
});

void test('the local stream includes a digest only for an opt-in buyer', async () => {
  const host = await startFreeBuyerHttp(
    async () => ({
      text: 'synthetic',
      finishReason: ENGINE_DONE_REASONS.STOP,
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 8,
    },
    {
      port: 0,
      stream: async (_input, _signal, emit) => {
        await emit('synthetic', DIGEST);
        throw new Error('synthetic stop');
      },
    },
  );
  try {
    const input = {
      model: 'synthetic',
      messages: [{ role: 'user', content: 'synthetic' }],
      max_tokens: 8,
      stream: true,
    };
    const ordinary = await fetch(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal((await ordinary.text()).includes(DIGEST), false);
    const result = await chatTurn(
      {
        model: 'synthetic',
        maxTokens: 8,
        prompt: 'synthetic',
        paid: true,
        write: () => {},
      },
      (_url, init) => fetch(host.url, init),
    );
    assert.equal(result.requestDigest, DIGEST);
    assert.equal(result.status, 'uncertain');
  } finally {
    await host.close();
  }
});

void test('a paid cut binds the streamed digest to its authorized attempt', async () => {
  const buyer = await setup();
  buyer.scripts.push(async (_request, emit) => {
    await emit('synthetic');
    throw new PaidClientError(PAID_EXECUTION_CODES.TIMEOUT, true);
  });
  const paid = paidChat(buyer.dependencies);
  const host = await startFreeBuyerHttp(
    paid.execute,
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 50,
    },
    { port: 0, stream: paid.stream, classify: classifyPaidError },
  );
  try {
    const result = await chatTurn(
      {
        model: 'synthetic',
        maxTokens: 50,
        prompt: 'synthetic',
        paid: true,
        write: () => {},
      },
      (_url, init) => fetch(host.url, init),
    );
    assert.equal(result.status, 'uncertain');
    assert.equal(result.requestDigest, buyer.calls.authorize[0]?.requestDigest);
    assert.equal(buyer.calls.authorize.length, 1);
    assert.equal(buyer.calls.executed.length, 1);
  } finally {
    await host.close();
  }
});

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
