// Buyer terminal requests use synthetic local responses; no inference or payments occur.
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatTurn, type ChatTurnOptions } from '@gyblos/buyer/chat-cli-turn';

const terminal = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 }, gyblos_payment: { verdict: 'settled', chargedAtomic: '5', refundedAtomic: '7' } });
const delta = JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] });
const stream = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const setup = () => {
  const output: string[] = [];
  const options: ChatTurnOptions = { model: 'synthetic', maxTokens: 8, prompt: 'example', token: 'synthetic', write: (text) => output.push(text) };
  return { options, output };
};

void test('streams one answer and reports usage and paid settlement', async () => {
  const { options, output } = setup();
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:4031/v1/chat/completions');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic');
    assert.deepEqual(JSON.parse(String(init?.body)).messages, [{ role: 'user', content: 'example' }]);
    return stream(`data: ${delta}\n\ndata: ${terminal}\n\ndata: [DONE]\n\n`);
  };
  const result = await chatTurn(options, request);
  assert.equal(calls, 1);
  assert.equal(output.join(''), 'Hello');
  assert.deepEqual(result, { status: 'complete', usage: { input: 2, output: 3 }, payment: { verdict: 'settled', charged: '5', refunded: '7' } });
});

void test('incomplete streams and network errors never retry the prompt', async () => {
  for (const response of [() => stream(`data: ${delta}\n\n`), () => { throw new Error('private'); }]) {
    const { options } = setup();
    let calls = 0;
    const request: typeof fetch = async () => { calls++; return response(); };
    assert.equal((await chatTurn(options, request)).status, 'uncertain');
    assert.equal(calls, 1);
  }
});

void test('rejects oversized prompts before making a request', async () => {
  const { options } = setup();
  options.prompt = 'x'.repeat(200_000);
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return stream(''); };
  assert.equal((await chatTurn(options, request)).status, 'rejected');
  assert.equal(calls, 0);
});

void test('never reports a paid stream with unverified settlement as complete', async () => {
  const { options } = setup();
  const unverified = terminal.replace('settled', 'unverified');
  const request: typeof fetch = async () => stream(`data: ${delta}\n\ndata: ${unverified}\n\ndata: [DONE]\n\n`);
  assert.equal((await chatTurn(options, request)).status, 'uncertain');
});

void test('a remote failure or cancelled request ends without retry or revealing error text', async () => {
  const { options, output } = setup();
  const request: typeof fetch = async () => stream('data: {"error":{"message":"secret"}}\n\n');
  assert.equal((await chatTurn(options, request)).status, 'uncertain');
  assert.equal(output.join('').includes('secret'), false);
});
