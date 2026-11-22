import assert from 'node:assert/strict';
import test from 'node:test';

import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { BUYER_API } from '@gyblos/protocol/buyer-api';

import { budget, policy, reply, token } from './support/desktop-paid-chat';

void test('desktop Auto sends the model without pinning a seller and records its channel approval', async () => {
  const ledger = budget();
  let sends = 0;
  const client = new X402Client(ledger, async (url, options) => {
    if (options?.method !== 'POST')
      return Response.json({
        ...policy,
        paidAuto: true,
        depositAtomic: '1000000',
        lifetimeMs: 3600000,
      });
    assert.equal(new URL(String(url)).pathname, BUYER_API.CHANNEL_CHAT_PATH);
    const request = JSON.parse(String(options.body));
    assert.equal(request[BUYER_API.AUTO_FIELD], true);
    assert.equal(request[BUYER_API.SELLER_CHOICE_FIELD], undefined);
    sends++;
    return Response.json(reply());
  });
  await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
  await client.send('automatic', 'test', undefined, 'auto');
  assert.equal(sends, 1);
  assert.equal((await ledger.summary()).spentAtomic, '30');
  await client.close();
});

void test('an approved Auto charge fits the spending journal independently of the network model catalog', async () => {
  const ledger = new X402Budget({
    read: async () => undefined,
    write: async (text) => {
      if (Buffer.byteLength(text) > 4000)
        throw new Error('Synthetic journal limit');
      assert.ok(!text.includes('autoRoutes'));
    },
  });
  const autoRoutes = Array.from({ length: 32 }, (_, i) => ({
    id: 'local-model-' + i,
    modelId: 'network-model-' + i,
    maxTokens: 32,
  }));
  const client = new X402Client(ledger, async (_url, options) =>
    options?.method === 'POST'
      ? Response.json(reply())
      : Response.json({
          ...policy,
          depositAtomic: '1000000',
          lifetimeMs: 3600000,
          paidAuto: true,
          autoRoutes,
        }),
  );
  await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
  await client.send('bounded-auto', 'test', undefined, BUYER_API.AUTO);
  const state = await ledger.summary();
  assert.equal(state.blocked, false);
  assert.equal(state.spentAtomic, '30');
  assert.equal(client.policy()?.autoRoutes?.length, 32);
  await client.close();
});
