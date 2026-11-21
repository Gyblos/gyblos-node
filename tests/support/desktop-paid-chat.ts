// Synthetic buyer policy, spending store and paid reply for desktop channel tests.
import { DEVNET, DEVNET_USDC } from '@gyblos/config';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { BUYER_API, type BuyerApiPolicy } from '@gyblos/protocol/buyer-api';

export const policy: BuyerApiPolicy = {
  version: 1,
  policyId: '00000000-0000-4000-8000-000000000001',
  model: 'qwen3-0.6b',
  maxTokens: 128,
  maxAtomic: '100',
  network: DEVNET,
  mint: DEVNET_USDC,
  payer: '11111111111111111111111111111111',
};
export const token = 'synthetic-ephemeral-local-token';
export function budget() {
  let saved: string | undefined;
  return new X402Budget({
    read: async () => saved,
    write: async (text) => {
      saved = text;
    },
  });
}
export function reply() {
  return {
    model: policy.model,
    choices: [
      {
        message: { role: 'assistant', content: 'Hello from the model' },
        finish_reason: 'stop',
      },
    ],
    [BUYER_API.EXECUTION_FIELD]: 'paid',
    [BUYER_API.PAYMENT_FIELD]: {
      verdict: 'approved',
      maxAtomic: '100',
      expectedAtomic: '30',
      chargedAtomic: null,
      refundedAtomic: null,
      sellerAtomic: null,
      feeAtomic: null,
      recorded: true,
      session: {
        approvedAtomic: '30',
        cumulativeAtomic: '30',
        depositAtomic: '100',
      },
    },
  };
}
