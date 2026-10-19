import type { KeyPairSigner } from '@solana/kit';
import {
  decodePaymentResponseHeader,
  wrapFetchWithPayment,
  x402Client,
} from '@x402/fetch';
import { UptoSvmScheme } from '@x402/svm/upto/client';

import { DEVNET } from './constants.js';
import { validateTerms, type TrustPolicy } from './trust.js';

export function createInferenceBuyer(
  signer: KeyPairSigner,
  rpcUrl: string,
  policy: TrustPolicy,
  hooks: {
    beforeSigning: () => void;
    authorized: (channelId: string, ceiling: string) => Promise<void>;
  },
) {
  // Measure at the signer boundary, excluding the initial challenge and RPC build.
  const timedSigner = {
    ...signer,
    async signTransactions(
      ...args: Parameters<typeof signer.signTransactions>
    ) {
      hooks.beforeSigning();
      return signer.signTransactions(...args);
    },
  };
  const timedClient = new x402Client().register(
    DEVNET,
    new UptoSvmScheme(timedSigner, { rpcUrl }),
  );
  timedClient.setSpendControls({
    allowedAssets: [
      {
        network: DEVNET,
        asset: policy.mint,
        maxAmountPerPayment: policy.maxAtomic,
      },
    ],
  });
  timedClient.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    validateTerms(selectedRequirements, policy);
  });
  timedClient.onAfterPaymentCreation(
    async ({ paymentPayload, selectedRequirements }) => {
      const id = paymentPayload.payload.channelId;
      if (typeof id !== 'string')
        throw new Error('Missing inference channel ID.');
      await hooks.authorized(id, selectedRequirements.amount);
    },
  );
  const paidFetch = wrapFetchWithPayment(fetch, timedClient);
  return async (url: string, request: unknown, signal?: AbortSignal) => {
    const response = await paidFetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.any([
        AbortSignal.timeout(180_000),
        ...(signal ? [signal] : []),
      ]),
    });
    const body: unknown = await response.json();
    const receivedAt = performance.now();
    const header = response.headers.get('PAYMENT-RESPONSE');
    return {
      status: response.status,
      body,
      receivedAt,
      receipt: header ? decodePaymentResponseHeader(header) : undefined,
    };
  };
}
