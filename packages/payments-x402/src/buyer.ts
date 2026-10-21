import type { KeyPairSigner, Signature } from '@solana/kit';
import type { PaymentRequirements } from '@x402/core/types';
import {
  decodePaymentResponseHeader,
  wrapFetchWithPayment,
  x402Client,
} from '@x402/fetch';
import { UptoSvmScheme } from '@x402/svm/upto/client';

import { TIMEOUTS } from '@gyblos/config';
import {
  BUYER_DIAGNOSTIC_CODES,
  DEVNET,
  type BuyerDiagnosticCode,
} from '@gyblos/payments-x402/constants';
import { validateTerms, type TrustPolicy } from '@gyblos/payments-x402/trust';

import { signatureHint } from './signature-hint.js';

export interface BuyerResponseObservation {
  status: number;
  claimSignature?: Signature;
}

export interface BuyerResult {
  status: number;
  authorization?: { channelId: string; requirements: PaymentRequirements };
  settlement?: ReturnType<typeof decodePaymentResponseHeader>;
  body: unknown;
  receivedAt?: number;
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
  hooks: {
    beforeSigning?: () => void;
    authorizationError?: string;
    responseObserved?: (
      observation: BuyerResponseObservation,
    ) => Promise<void> | void;
    responseObservationFailed?: (code: BuyerDiagnosticCode) => void;
  } = {},
) {
  let authorization:
    { channelId: string; requirements: PaymentRequirements } | undefined;
  const client = new x402Client().register(
    DEVNET,
    new UptoSvmScheme(
      hooks.beforeSigning
        ? {
            ...signer,
            async signTransactions(
              ...args: Parameters<typeof signer.signTransactions>
            ) {
              hooks.beforeSigning?.();
              return signer.signTransactions(...args);
            },
          }
        : signer,
      { rpcUrl },
    ),
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
      const channelId = paymentPayload.payload.channelId;
      if (typeof channelId !== 'string')
        throw new Error(
          hooks.authorizationError ?? 'SDK did not provide a channel ID.',
        );
      authorization = {
        channelId: channelId,
        requirements: selectedRequirements,
      };
      await onAuthorization?.(authorization);
    },
  );
  const paidFetch = wrapFetchWithPayment(fetchImpl, client);
  return {
    async request(
      url: string,
      signal?: AbortSignal,
      options: {
        method?: 'POST';
        body?: unknown;
        timeoutMs?: number;
        measureResponse?: boolean;
      } = {},
    ): Promise<BuyerResult> {
      authorization = undefined;
      // No application retry: a lost response may already have settled.
      const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUTS.buyer);
      const response = await paidFetch(url, {
        redirect: 'error',
        ...(options.method
          ? {
              method: options.method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(options.body),
            }
          : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const receipt = () => {
        const header = response.headers.get('PAYMENT-RESPONSE');
        return header ? decodePaymentResponseHeader(header) : undefined;
      };
      let settlement: BuyerResult['settlement'];
      try {
        settlement = options.measureResponse ? undefined : receipt();
        const body: unknown = await response.json();
        const receivedAt = options.measureResponse
          ? performance.now()
          : undefined;
        if (options.measureResponse) settlement = receipt();
        return {
          status: response.status,
          authorization,
          settlement,
          body,
          ...(receivedAt !== undefined ? { receivedAt } : {}),
        };
      } finally {
        if (hooks.responseObserved) {
          // A receipt is an unverified hint, including when body parsing fails.
          if (!settlement) {
            try {
              settlement = receipt();
            } catch {
              // Invalid headers must not erase the original response error.
            }
          }
          try {
            const claimSignature = signatureHint(settlement?.transaction);
            await hooks.responseObserved({
              status: response.status,
              ...(claimSignature ? { claimSignature } : {}),
            });
          } catch {
            // An observer failure must not replace the original result or
            // error; it is reported only as a canonical code.
            try {
              const reported: unknown = hooks.responseObservationFailed?.(
                BUYER_DIAGNOSTIC_CODES.RESPONSE_OBSERVATION_FAILED,
              );
              // An asynchronous reporter may reject; consume it so it can
              // neither crash the process nor expose its error.
              void Promise.resolve(reported).catch(() => undefined);
            } catch {
              // A failing reporter must not replace the outcome either.
            }
          }
        }
      }
    },
  };
}
