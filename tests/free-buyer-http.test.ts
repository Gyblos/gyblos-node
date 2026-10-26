// Exercises the local compatibility endpoint with a synthetic executor and no inference/payment services.
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';

void test('free HTTP returns a complete completion and refuses unsupported input before execution', async () => {
  const api = await import('@gyblos/buyer/free-http');
  let calls = 0;
  const server = await api.startFreeBuyerHttp(async () => {
    calls++;
    return { text: 'answer', usage: { inputTokens: 4, outputTokens: 2 }, finishReason: ENGINE_DONE_REASONS.STOP };
  }, { selection: { modelId: 'synthetic', variant: null, quantization: null }, maxTokens: 10 }, { port: 0 });
  try {
    const body = { model: 'synthetic', messages: [{ role: 'user', content: 'hello' }] };
    const response = await fetch(server.url, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.choices[0].message.content, 'answer');
    assert.deepEqual(value.usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    const rejected = await fetch(server.url, { method: 'POST', body: JSON.stringify({ ...body, stream: true }) });
    assert.equal(rejected.status, 400);
    assert.equal(calls, 1);
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(server.url, { method: 'POST', headers: { host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject);
      request.end(JSON.stringify(body));
    });
    assert.notEqual(wrongHost, 200);
    assert.equal(calls, 1);
  } finally { await server.close(); }
});
