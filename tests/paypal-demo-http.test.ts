import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startPaypalDemo } from '@gyblos/node-app/paypal-demo';

void test('loopback demo requires same origin and connects one approval to multiple inferences', async () => {
  const operations: string[] = [];
  let state: unknown = null;
  const app = await startPaypalDemo({
    port: 0,
    journal: {
      async read() {
        return state;
      },
      async write(value) {
        state = structuredClone(value);
      },
    },
    payment: {
      async isApproved() {
        return true;
      },
      async create() {
        operations.push('create');
        return {
          orderId: 'ORDER1',
          approvalUrl:
            'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
        };
      },
      async authorize() {
        operations.push('authorize');
        return { authorizationId: 'AUTH1' };
      },
      async capture(_id: string, cents?: number) {
        operations.push(`capture:${cents}`);
        return { captureId: 'CAPTURE1' };
      },
      async void() {
        operations.push('void');
      },
    },
    engine: {
      async generate() {
        operations.push('generate');
        return { text: 'answer', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
  });
  try {
    const session = new URL(app.accessUrl).hash.slice(1);
    const headers = {
      'content-type': 'application/json',
      origin: app.url,
      authorization: `Bearer ${session}`,
    };
    const post = (path: string, data: unknown, requestHeaders = headers) =>
      fetch(`${app.url}${path}`, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(data),
      });
    assert.equal(
      (
        await post(
          '/api/order',
          {},
          { ...headers, authorization: 'Bearer invalid' },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          '/api/order',
          {},
          { ...headers, origin: 'https://attacker.invalid' },
        )
      ).status,
      403,
    );
    const created = await post('/api/order', {});
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), {
      orderId: 'ORDER1',
      approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER1',
    });
    assert.equal(
      (await post('/api/approve', { orderId: 'ORDER1' })).status,
      200,
    );
    for (const prompt of ['hello', 'again']) {
      const response = await post('/api/message', { prompt, maxTokens: 16 });
      assert.equal(response.status, 200);
      const result: unknown = await response.json();
      assert.ok(result && typeof result === 'object' && 'messageId' in result);
      assert.equal(
        (await post('/api/acknowledge', { messageId: result.messageId }))
          .status,
        200,
      );
    }
    const finish = await post('/api/finish', {});
    assert.equal(finish.status, 200);
    assert.deepEqual(operations, [
      'create',
      'authorize',
      'generate',
      'generate',
      'capture:20',
    ]);
  } finally {
    await app.close();
  }
});
