import type { KeyPairSigner } from '@solana/kit';
import type { PaymentRequirements } from '@x402/core/types';
import {
  decodePaymentResponseHeader,
  wrapFetchWithPayment,
  x402Client,
} from '@x402/fetch';
import { UptoSvmScheme } from '@x402/svm/upto/client';

import { DEVNET } from './constants.js';
import { validateTerms, type TrustPolicy } from './trust.js';

export interface BuyerResult {
  status: number;
  authorization?: { channelId: string; requirements: PaymentRequirements };
  settlement?: ReturnType<typeof decodePaymentResponseHeader>;
  body: unknown;
}

export function createBuyer(
  signer: KeyPairSigner,
  rpcUrl: string,
  policy: TrustPolicy,
  fetchImpl: typeof fetch = fetch,
  onAuthorization?: (authorization: {
    channelId: string;
    requirements: PaymentRequirements;
  }) => Promise<void>,
) {
  let authorization:
    { channelId: string; requirements: PaymentRequirements } | undefined;
  const client = new x402Client().register(
    DEVNET,
    new UptoSvmScheme(signer, { rpcUrl }),
  );
  client.setSpendControls({
    allowedAssets: [
      {
        network: DEVNET,
        asset: policy.mint,
        maxAmountPerPayment: policy.maxAtomic,
      },
    ],
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    validateTerms(selectedRequirements, policy);
  });
  client.onAfterPaymentCreation(
    async ({ paymentPayload, selectedRequirements }) => {
      const id = paymentPayload.payload.channelId;
      if (typeof id !== 'string')
        throw new Error('SDK did not provide a channel ID.');
      authorization = { channelId: id, requirements: selectedRequirements };
      await onAuthorization?.(authorization);
    },
  );
  const paidFetch = wrapFetchWithPayment(fetchImpl, client);
  return {
    async request(url: string, signal?: AbortSignal): Promise<BuyerResult> {
      authorization = undefined;
      // No application retry: a lost response may already have settled.
      const timeout = AbortSignal.timeout(120_000);
      const response = await paidFetch(url, {
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const header = response.headers.get('PAYMENT-RESPONSE');
      const settlement = header
        ? decodePaymentResponseHeader(header)
        : undefined;
      const body: unknown = await response.json();
      return { status: response.status, authorization, settlement, body };
    },
  };
}
