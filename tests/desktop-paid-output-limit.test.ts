// Check the request sent to a selected paid seller using the normal desktop client.
import assert from 'node:assert/strict';
import test from 'node:test';

import { X402Client } from '@gyblos/desktop/x402-client';
import { BATCH_CHANNEL } from '@gyblos/protocol/batch-channel';

import { budget, policy, reply, token } from './support/desktop-paid-chat';

void test('selected paid chat respects the channel, buyer and seller output limits on the wire', async () => {
  for (const [maxTokens, contextTokens, expected] of [
    [4096, 16384, BATCH_CHANNEL.maxOutputTokens],
    [32, 16384, 32],
    [4096, 64, 64],
  ] as const) {
    const client = new X402Client(budget(), async (_url, options) => {
      if (options?.method !== 'POST')
        return Response.json({
          ...policy,
          maxTokens,
          depositAtomic: '1000000',
          lifetimeMs: 3600000,
        });
      const body: unknown = JSON.parse(String(options.body));
      assert.ok(body && typeof body === 'object' && 'max_tokens' in body);
      assert.equal(body.max_tokens, expected);
      return Response.json(reply());
    });
    try {
      await client.connect('http://127.0.0.1:8090/v1/chat/completions', token);
      await client.send('selected-seller', 'Synthetic input', undefined, {
        owner: policy.payer,
        nodeId: 'a'.repeat(64),
        modelId: policy.model,
        variant: null,
        quantization: null,
        contextTokens,
        inputAtomicPerMtok: '100',
        outputAtomicPerMtok: '200',
        expiresAt: Date.now() + 60000,
      });
    } finally {
      await client.close();
    }
  }
});
