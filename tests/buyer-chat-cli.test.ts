// Buyer terminal requests use synthetic local responses; no inference or payments occur.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatSession } from '@gyblos/buyer/chat-cli';
import { chatTurn, type ChatTurnOptions } from '@gyblos/buyer/chat-cli-turn';
import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

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
    token: 'synthetic',
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
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer synthetic',
    );
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

void test('session stops immediately after an uncertain result and asks for reconciliation', async () => {
  const output: string[] = [];
  let reads = 0;
  let calls = 0;
  await chatSession({
    model: 'synthetic',
    maxTokens: 8,
    maxAtomic: '100',
    token: 'synthetic',
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
    options.token = undefined;
    const request: typeof fetch = async (_url, init) => fetch(host.url, init);
    const result = await chatTurn(options, request);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.usage, { input: 1, output: 2 });
    assert.equal(output.join(''), 'local');
  } finally {
    await host.close();
  }
});
