// A verified charge stays durable when Stop races its disk write; its late reply stays suppressed.
import assert from 'node:assert/strict';
import test from 'node:test';

import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { BUYER_API } from '@gyblos/protocol/buyer-api';
import { OFFER_PRICING_KINDS } from '@gyblos/protocol/constants';

import { latch, policy } from './support/desktop-stream';

void test('desktop Stop during final persistence rejects the late reply and retains the verified charge', async () => {
  const committing = latch();
  const release = latch();
  let saved: string | undefined;
  let posts = 0;
  const files = { read: async () => saved, write: async (text: string) => {
    if (JSON.parse(text).summary.records.length) { committing.resolve(); await release.promise; }
    saved = text;
  } };
  const budget = new X402Budget(files);
  const paid = { ...policy, maxAtomic: '100' };
  const client = new X402Client(budget, async (_url, options) => {
    if (options?.method !== 'POST') return Response.json(paid);
    posts++;
    return Response.json({ model: policy.model,
      choices: [{ message: { role: 'assistant', content: 'Verified answer' }, finish_reason: 'stop' }],
      [BUYER_API.EXECUTION_FIELD]: OFFER_PRICING_KINDS.PAID,
      [BUYER_API.PAYMENT_FIELD]: { verdict: 'settled', maxAtomic: '100', expectedAtomic: '30', chargedAtomic: '30', refundedAtomic: '70', transaction: '2'.repeat(88) },
    });
  });
  await client.connect('http://127.0.0.1:8090/v1/chat/completions', 'synthetic-local-buyer-token');
  await client.authorize('100');
  const pending = client.send('persist-one', 'Synthetic question');
  const settled = Promise.allSettled([pending]);
  try {
    await committing.promise;
    assert.equal(client.stop('persist-one'), true);
    release.resolve();
    await assert.rejects(pending);
    const summary = await new X402Budget(files).summary();
    assert.equal(summary.blocked, false);
    assert.equal(summary.spentAtomic, '30');
    assert.equal(summary.records[0]?.transaction, '2'.repeat(88));
    assert.equal(posts, 1);
  } finally { release.resolve(); await settled; await client.close(); }
});
