import type { KeyPairSigner } from '@solana/kit';

import { TIMEOUTS } from '@gyblos/config';

import { createBuyer } from './buyer.js';
import type { TrustPolicy } from './trust.js';

export function createInferenceBuyer(
  signer: KeyPairSigner,
  rpcUrl: string,
  policy: TrustPolicy,
  hooks: {
    beforeSigning: () => void;
    authorized: (channelId: string, ceiling: string) => Promise<void>;
  },
) {
  const buyer = createBuyer(
    signer,
    rpcUrl,
    policy,
    fetch,
    async (authorization) =>
      hooks.authorized(
        authorization.channelId,
        authorization.requirements.amount,
      ),
    {
      beforeSigning: hooks.beforeSigning,
      authorizationError: 'Missing inference channel ID.',
    },
  );
  return async (url: string, request: unknown, signal?: AbortSignal) => {
    const response = await buyer.request(url, signal, {
      method: 'POST',
      body: request,
      timeoutMs: TIMEOUTS.inference,
      measureResponse: true,
    });
    return {
      status: response.status,
      body: response.body,
      receivedAt: response.receivedAt!,
      receipt: response.settlement,
    };
  };
}
