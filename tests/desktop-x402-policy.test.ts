// The wallet shown in Payments must be the wallet copied, including buyer changes.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getBase58Decoder } from '@solana/kit';

import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createX402Handlers } from '@gyblos/desktop/x402-handlers';
import { X402_ACTION } from '@gyblos/desktop/x402-model';
import type { BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

const policy: BuyerApiPolicy = {
  version: 1,
  policyId: '00000000-0000-4000-8000-000000000001',
  model: 'model-a',
  maxTokens: 128,
  maxAtomic: '100',
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  mint: '11111111111111111111111111111111',
  payer: '11111111111111111111111111111111',
};
const other = {
  ...policy,
  policyId: '00000000-0000-4000-8000-000000000002',
  model: 'model-b',
  payer: getBase58Decoder().decode(new Uint8Array(32).fill(2)),
  mint: getBase58Decoder().decode(new Uint8Array(32).fill(3)),
};

void test('Payments copies the displayed active wallet and then the newly connected wallet after finishing', async () => {
  const budget = new X402Budget({
    read: async () => undefined,
    write: async () => {},
  });
  await budget.authorize(policy, '100');
  const client = new X402Client(budget, async () => Response.json(other));
  await client.connect(
    'http://127.0.0.1:8090/v1/chat/completions',
    'synthetic-ephemeral-local-token',
  );
  const owner = {};
  const frame = {};
  const copied: string[] = [];
  const handler = createX402Handlers(
    client,
    budget,
    { contents: owner, mainFrame: () => frame, destroyed: () => false },
    async () => {},
    undefined,
    (value) => {
      copied.push(value);
    },
  );
  for (const [expected, finished] of [
    [policy, false],
    [other, true],
  ] as const) {
    if (finished) await budget.finish();
    for (const action of [X402_ACTION.COPY_PAYER, X402_ACTION.COPY_MINT]) {
      const result = await handler({ sender: owner, senderFrame: frame }, [
        { action, policyId: expected.policyId },
      ]);
      assert.equal(result.error, undefined);
      assert.equal(
        copied.at(-1),
        action === X402_ACTION.COPY_PAYER ? expected.payer : expected.mint,
      );
    }
  }
  const count = copied.length;
  const stale = await handler({ sender: owner, senderFrame: frame }, [
    { action: X402_ACTION.COPY_PAYER, policyId: policy.policyId },
  ]);
  assert.ok(stale.error);
  assert.equal(copied.length, count);
});
