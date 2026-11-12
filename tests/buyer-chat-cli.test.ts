// Buyer terminal requests use synthetic local responses; no inference or payments occur.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatSession, runOwnedChat } from '@gyblos/buyer/chat-cli';
import { chatTurn, type ChatTurnOptions } from '@gyblos/buyer/chat-cli-turn';
import { ownedChat } from '@gyblos/buyer/chat-owned';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import {
  ENGINE_DONE_REASONS,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';

const terminal = JSON.stringify({
  choices: [{ delta: {}, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 3 },
  gyblos_payment: {
    verdict: 'settled',
    chargedAtomic: '5',
    refundedAtomic: '7',
  },
});
const delta = JSON.stringify({
  choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
});
const stream = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
const setup = () => {
  const output: string[] = [];
  const options: ChatTurnOptions = {
    model: 'synthetic',
    maxTokens: 8,
    prompt: 'example',
    paid: true,
    write: (text) => output.push(text),
  };
  return { options, output };
};

void test('streams one answer and reports usage and paid settlement', async () => {
  const { options, output } = setup();
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:4031/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.deepEqual(JSON.parse(String(init?.body)).messages, [
      { role: 'user', content: 'example' },
    ]);
    return stream(`data: ${delta}\n\ndata: ${terminal}\n\ndata: [DONE]\n\n`);
  };
  const result = await chatTurn(options, request);
  assert.equal(calls, 1);
  assert.equal(output.join(''), 'Hello');
  assert.deepEqual(result, {
    status: 'complete',
    text: 'Hello',
    usage: { input: 2, output: 3 },
    payment: { verdict: 'settled', charged: '5', refunded: '7' },
  });
});

void test('incomplete streams and network errors never retry the prompt', async () => {
  for (const response of [
    () => stream(`data: ${delta}\n\n`),
    () => {
      throw new Error('private');
    },
  ]) {
    const { options } = setup();
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      return response();
    };
    assert.equal((await chatTurn(options, request)).status, 'uncertain');
    assert.equal(calls, 1);
  }
});

void test('rejects oversized prompts before making a request', async () => {
  const { options } = setup();
  options.prompt = 'x'.repeat(200_000);
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return stream('');
  };
  assert.equal((await chatTurn(options, request)).status, 'rejected');
  assert.equal(calls, 0);
});

void test('never reports a paid stream with unverified settlement as complete', async () => {
  const { options } = setup();
  const unverified = terminal.replace('settled', 'unverified');
  const request: typeof fetch = async () =>
    stream(`data: ${delta}\n\ndata: ${unverified}\n\ndata: [DONE]\n\n`);
  assert.equal((await chatTurn(options, request)).status, 'uncertain');
});

void test('a remote failure or cancelled request ends without retry or revealing error text', async () => {
  const { options, output } = setup();
  const request: typeof fetch = async () =>
    stream('data: {"error":{"message":"secret"}}\n\n');
  assert.equal((await chatTurn(options, request)).status, 'uncertain');
  assert.equal(output.join('').includes('secret'), false);
});

void test('preserves typed remote error and settlement without revealing arbitrary error text', async () => {
  const { options, output } = setup();
  const detail = {
    error: {
      code: 'FREE_EXECUTION_SELLER_CANNOT_CONTINUE',
      message: 'secret',
      gyblos_payment: {
        verdict: 'settled',
        chargedAtomic: '5',
        refundedAtomic: '7',
      },
    },
  };
  const request: typeof fetch = async () =>
    stream(`data: ${JSON.stringify(detail)}\n\n`);
  const result = await chatTurn(options, request);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.code, 'FREE_EXECUTION_SELLER_CANNOT_CONTINUE');
  assert.deepEqual(result.payment, {
    verdict: 'settled',
    charged: '5',
    refunded: '7',
  });
  assert.equal(output.join('').includes('secret'), false);
});

void test('preserves a bounded JSON error payment without echoing remote text', async () => {
  const { options, output } = setup();
  const body = {
    error: {
      code: 'PAID_BUYER_UNAUTHORIZED',
      message: 'private',
      gyblos_payment: {
        verdict: 'unverified',
        chargedAtomic: null,
        refundedAtomic: null,
      },
    },
  };
  const request: typeof fetch = async () =>
    new Response(JSON.stringify(body), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  const result = await chatTurn(options, request);
  assert.equal(result.code, 'PAID_BUYER_UNAUTHORIZED');
  assert.equal(result.payment?.verdict, 'unverified');
  assert.equal(output.join('').includes('private'), false);
});

void test('preserves known selection and payment error codes', async () => {
  for (const code of [
    SELLER_SELECTION_CODES.PINNED_IN_COOLDOWN,
    PAYMENT_ERROR_CODES.ALREADY_SETTLED,
  ]) {
    const { options } = setup();
    const request: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: { code, message: 'do not show' } }),
        { status: 503 },
      );
    assert.equal((await chatTurn(options, request)).code, code);
  }
});

void test('decodes fragmented streaming events and does not retry after cancellation', async () => {
  const { options, output } = setup();
  const bytes = new TextEncoder().encode(
    `data: ${delta}\n\ndata: ${terminal}\n\ndata: [DONE]\n\n`,
  );
  const request: typeof fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  assert.equal((await chatTurn(options, request)).status, 'complete');
  assert.equal(output.join(''), 'Hello');
  const abort = new AbortController();
  options.signal = abort.signal;
  let calls = 0;
  const cancelled: typeof fetch = async (_url, init) => {
    calls++;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${delta}\n\n`));
          init?.signal?.addEventListener('abort', () =>
            controller.error(new Error('aborted')),
          );
          abort.abort();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  assert.equal((await chatTurn(options, cancelled)).status, 'uncertain');
  assert.equal(calls, 1);
});

void test('accepts protocol-sized output whose JSON escaping exceeds one mebibyte', async () => {
  const { options } = setup();
  const chunk = JSON.stringify({
    choices: [
      { delta: { content: '\u0001'.repeat(4096) }, finish_reason: null },
    ],
  });
  const request: typeof fetch = async () =>
    stream(
      `${`data: ${chunk}\n\n`.repeat(48)}data: ${terminal}\n\ndata: [DONE]\n\n`,
    );
  assert.equal((await chatTurn(options, request)).status, 'complete');
});

void test('session stops immediately after an uncertain result and asks for reconciliation', async () => {
  const output: string[] = [];
  let reads = 0;
  let calls = 0;
  await chatSession({
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '100',
    request: async () => stream(''),
    read: async () => {
      reads++;
      return 'test question';
    },
    write: (value) => output.push(value),
    turn: async () => {
      calls++;
      return {
        status: 'uncertain',
        payment: { verdict: 'unverified', charged: null, refunded: null },
      };
    },
  });
  assert.equal(reads, 1);
  assert.equal(calls, 1);
  assert.match(output.join(''), /unverified/);
  assert.match(output.join(''), /reconcile/);
  assert.doesNotMatch(output.join(''), /synthetic.*token/i);
});

void test('a pre-aborted request never sends a prompt', async () => {
  const { options } = setup();
  options.signal = AbortSignal.abort();
  let calls = 0;
  const request: typeof fetch = async () => {
    calls++;
    return stream('');
  };
  assert.equal((await chatTurn(options, request)).status, 'rejected');
  assert.equal(calls, 0);
});

void test('owned buyer uses its actual startup budget and closes after the session', async () => {
  const output: string[] = [];
  let closed = false;
  let requestedPort: number | undefined;
  await runOwnedChat(
    async (options) => {
      requestedPort = options.port;
      return {
        chat: {
          model: 'actual-model',
          maxTokens: 8,
          maxAtomic: '500',
          request: async () =>
            stream(`data: ${delta}\n\ndata: ${terminal}\n\ndata: [DONE]\n\n`),
        },
        close: async () => {
          closed = true;
        },
      };
    },
    async () => '/exit',
    (line) => output.push(line),
  );
  assert.equal(requestedPort, 0);
  assert.match(output.join(''), /actual-model/);
  assert.match(output.join(''), /500/);
  assert.equal(closed, true);
});

void test('streams from the real local buyer HTTP handler with a fake engine', async () => {
  const host = await startFreeBuyerHttp(
    async () => ({
      text: 'local',
      finishReason: ENGINE_DONE_REASONS.STOP,
      usage: { inputTokens: 1, outputTokens: 2 },
    }),
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 8,
    },
    {
      port: 0,
      stream: async (_input, _signal, emit) => {
        await emit('local');
        return {
          text: 'local',
          finishReason: ENGINE_DONE_REASONS.STOP,
          usage: { inputTokens: 1, outputTokens: 2 },
        };
      },
    },
  );
  try {
    const { options, output } = setup();
    options.paid = false;
    const request: typeof fetch = async (_url, init) => fetch(host.url, init);
    const result = await chatTurn(options, request);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.usage, { input: 1, output: 2 });
    assert.equal(output.join(''), 'local');
  } finally {
    await host.close();
  }
});

void test('owned paid connection sends its token only to the endpoint it started', async () => {
  const host = await startFreeBuyerHttp(
    async () => ({
      text: 'x',
      finishReason: ENGINE_DONE_REASONS.STOP,
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    {
      selection: { modelId: 'synthetic', variant: null, quantization: null },
      maxTokens: 8,
    },
    { port: 0, token: 'private-synthetic-bearer' },
  );
  try {
    const connection = ownedChat(
      'synthetic',
      8,
      '100',
      host.url,
      'private-synthetic-bearer',
    );
    const result = await connection.request('http://example.invalid/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'synthetic',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    assert.equal(result.status, 200);
    assert.equal(
      JSON.stringify(connection).includes('private-synthetic-bearer'),
      false,
    );
    assert.equal(Object.hasOwn(connection, 'token'), false);
    assert.throws(() =>
      ownedChat(
        'model',
        8,
        '100',
        'https://example.invalid/v1/chat/completions',
        'secret',
      ),
    );
  } finally {
    await host.close();
  }
});
