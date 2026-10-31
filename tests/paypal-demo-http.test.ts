import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startPaypalDemo } from '@gyblos/node-app/paypal-demo';

void test('loopback demo requires same origin and connects checkout to inference', async () => {
  const operations: string[] = [];
  let state: unknown = null;
  const app = await startPaypalDemo({
    port: 0,
    journal: { async read() { return state; }, async write(value) { state = structuredClone(value); } },
    payment: {
      async create() { operations.push('create'); return { orderId: 'ORDER1', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' }; },
      async authorize() { operations.push('authorize'); return { authorizationId: 'AUTH1' }; },
      async capture() { operations.push('capture'); return { captureId: 'CAPTURE1' }; },
      async void() { operations.push('void'); },
    },
    engine: { async generate() { operations.push('generate'); return { text: 'answer', usage: { inputTokens: 1, outputTokens: 1 } }; } },
  });
  try {
    const headers = { 'content-type': 'application/json', origin: app.url };
    const rejected = await fetch(`${app.url}/api/order`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.invalid' }, body: '{}' });
    assert.equal(rejected.status, 403);
    const create = await fetch(`${app.url}/api/order`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello', maxTokens: 16 }) });
    assert.equal(create.status, 200);
    const order: unknown = await create.json();
    assert.deepEqual(order, { orderId: 'ORDER1', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1' });
    const execute = await fetch(`${app.url}/api/execute`, { method: 'POST', headers, body: JSON.stringify({ orderId: 'ORDER1', prompt: 'hello', maxTokens: 16 }) });
    assert.equal(execute.status, 200);
    assert.deepEqual(operations, ['create', 'authorize', 'generate', 'capture']);
  } finally { await app.close(); }
});
