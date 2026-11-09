// Exercises durable desktop spending permission without wallets, engines or chain calls.
import assert from 'node:assert/strict';
import test from 'node:test';

import { X402Budget } from '@gyblos/desktop/x402-budget';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

const policy: BuyerApiPolicy = {
  version: 1,
  policyId: '00000000-0000-4000-8000-000000000001',
  model: 'qwen3:0.6b',
  maxTokens: 128,
  maxAtomic: '100',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  mint: '11111111111111111111111111111111',
  payer: '11111111111111111111111111111111',
};
function memory() {
  let saved: string | undefined;
  return {
    read: async () => saved,
    write: async (text: string) => {
      saved = text;
    },
  };
}
void test('x402 reserves before dispatch and retains uncertainty after restart', async () => {
  const files = memory();
  const budget = new X402Budget(files);
  await budget.authorize(policy, '200');
  await budget.reserve('request-1');
  const restored = new X402Budget(files);
  assert.equal((await restored.summary()).blocked, true);
  await assert.rejects(() => restored.authorize(policy, '200'));
  await assert.rejects(() => restored.finish());
});
void test('x402 confirmed charge releases only the unused reservation', async () => {
  const budget = new X402Budget(memory());
  await budget.authorize(policy, '150');
  await budget.reserve('request-1');
  await budget.complete('request-1', {
    chargeAtomic: '40',
    transaction: '2'.repeat(88),
    free: false,
  });
  assert.equal((await budget.summary()).spentAtomic, '40');
  await budget.reserve('request-2');
  await budget.complete('request-2', {
    chargeAtomic: '30',
    transaction: '3'.repeat(88),
    free: false,
  });
  await assert.rejects(() => budget.reserve('request-3'));
  const closed = await budget.finish();
  assert.equal(closed.active, false);
  assert.equal(closed.records.length, 2);
});
void test('x402 persistence failure prevents dispatch reservation', async () => {
  const files = memory();
  const budget = new X402Budget(files);
  await budget.authorize(policy, '200');
  files.write = async () => {
    throw new Error('disk unavailable');
  };
  await assert.rejects(() => budget.reserve('request-1'));
  assert.equal((await budget.summary()).blocked, true);
});
void test('x402 free execution releases reservation without a transaction', async () => {
  const budget = new X402Budget(memory());
  await budget.authorize(policy, '100');
  await budget.reserve('request-1');
  await budget.complete('request-1', {
    chargeAtomic: '0',
    transaction: null,
    free: true,
  });
  const state = await budget.summary();
  assert.equal(state.spentAtomic, '0');
  assert.equal(state.blocked, false);
  assert.equal(state.records[0]?.transaction, null);
});
