import type { KeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import type {
  PaymentRequired,
  PaymentRequirements,
  SupportedResponse,
} from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';

import { PAYMENT_LIMITS } from '@gyblos/config';
import { GateError } from '@gyblos/payments-x402/chain';
import { DEVNET, DEVNET_USDC } from '@gyblos/payments-x402/constants';

export { EXACT_PRICE } from '@gyblos/application/constants';
export { PUBLIC_FACILITATORS } from '@gyblos/config';
export interface ExactPolicy {
  payTo: string;
  feePayer: string;
  amount: string;
}
export function assertExactSupport(body: SupportedResponse, feePayer: string) {
  const kind = body.kinds.find(
    (k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === DEVNET,
  );
  if (!kind || kind.extra?.feePayer !== feePayer)
    throw new GateError(
      'SUPPORT_CHANGED',
      'Public exact devnet support or its pinned fee payer changed. Stop and review.',
    );
}
export function validateExactTerms(
  terms: PaymentRequirements,
  policy: ExactPolicy,
) {
  if (
    terms.scheme !== 'exact' ||
    terms.network !== DEVNET ||
    terms.asset !== DEVNET_USDC ||
    terms.payTo !== policy.payTo ||
    terms.extra?.feePayer !== policy.feePayer ||
    terms.amount !== policy.amount ||
    !/^[1-9]\d*$/.test(terms.amount) ||
    !Number.isSafeInteger(terms.maxTimeoutSeconds) ||
    terms.maxTimeoutSeconds < 1 ||
    terms.maxTimeoutSeconds > PAYMENT_LIMITS.maxTimeoutSeconds ||
    terms.extra?.paymentFlow !== 'upfront'
  )
    throw new GateError(
      'UNTRUSTED_EXACT_TERMS',
      'Exact terms do not match pinned network, Circle USDC, price, recipient, fee payer and upfront flow.',
    );
}
export function createExactBuyer(
  signer: KeyPairSigner,
  rpcUrl: string,
  policy: ExactPolicy,
) {
  const client = new x402Client().register(
    DEVNET,
    new ExactSvmScheme(signer, { rpcUrl }),
  );
  client.setSpendControls({
    allowedAssets: [
      {
        network: DEVNET,
        asset: DEVNET_USDC,
        maxAmountPerPayment: policy.amount,
      },
    ],
  });
  client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
    validateExactTerms(selectedRequirements, policy);
  });
  return {
    async authorize(challenge: PaymentRequired, availableAtomic: string) {
      if (challenge.x402Version !== 2 || challenge.accepts.length !== 1)
        throw new GateError(
          'UNTRUSTED_EXACT_TERMS',
          'Expected one x402 V2 exact payment option.',
        );
      validateExactTerms(challenge.accepts[0]!, policy); // before SDK network access or signing
      if (
        !/^\d+$/.test(availableAtomic) ||
        BigInt(availableAtomic) < BigInt(policy.amount)
      )
        throw new GateError(
          'INSUFFICIENT_EXACT_USDC',
          'Buyer has insufficient Circle devnet USDC; no authorization created.',
        );
      return client.createPaymentPayload(challenge);
    },
  };
}

export function assertExactFallbackSafe(
  calls: { operation: string; outcome: string }[],
) {
  // Empty RPC history never proves an attempted settlement did not broadcast.
  if (
    calls.some((c) => c.operation === 'settle' || c.outcome === 'uncertain') ||
    !calls.some((c) => c.operation === 'verify' && c.outcome === 'rejected')
  )
    throw new GateError(
      'PUBLIC_OUTCOME_UNCERTAIN',
      'Cannot switch facilitator after a possible settlement; reconcile on-chain.',
    );
}
