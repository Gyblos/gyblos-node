import type { KeyPairSigner } from '@solana/kit';
import { x402Client } from '@x402/core/client';
import type {
  PaymentRequired,
  PaymentRequirements,
  SupportedResponse,
} from '@x402/core/types';
import { ExactSvmScheme } from '@x402/svm/exact/client';

import { PAYMENT_LIMITS } from '@gyblos/config';

import { GateError } from '../chain.js';
import {
  DEVNET,
  DEVNET_USDC,
  GATE_ERROR_CODES,
  PUBLIC_CALL_OPERATIONS,
  PUBLIC_CALL_OUTCOMES,
} from '../constants.js';
import type { PublicCall } from './types.js';

export interface ExactPolicy {
  payTo: string;
  feePayer: string;
  amount: string;
}

export { PUBLIC_FACILITATORS } from '@gyblos/config';

export function assertExactSupport(body: SupportedResponse, feePayer: string) {
  const kind = body.kinds.find(
    (kind) =>
      kind.x402Version === 2 &&
      kind.scheme === 'exact' &&
      kind.network === DEVNET,
  );
  if (!kind || kind.extra?.feePayer !== feePayer)
    throw new GateError(
      GATE_ERROR_CODES.SUPPORT_CHANGED,
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
      GATE_ERROR_CODES.UNTRUSTED_EXACT_TERMS,
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
          GATE_ERROR_CODES.UNTRUSTED_EXACT_TERMS,
          'Expected one x402 V2 exact payment option.',
        );
      validateExactTerms(challenge.accepts[0]!, policy); // before SDK network access or signing
      if (
        !/^\d+$/.test(availableAtomic) ||
        BigInt(availableAtomic) < BigInt(policy.amount)
      )
        throw new GateError(
          GATE_ERROR_CODES.INSUFFICIENT_EXACT_USDC,
          'Buyer has insufficient Circle devnet USDC; no authorization created.',
        );
      return client.createPaymentPayload(challenge);
    },
  };
}

export function assertExactFallbackSafe(
  calls: Pick<PublicCall, 'operation' | 'outcome'>[],
) {
  // Empty RPC history never proves an attempted settlement did not broadcast.
  if (
    calls.some(
      (call) =>
        call.operation === PUBLIC_CALL_OPERATIONS.SETTLE ||
        call.outcome === PUBLIC_CALL_OUTCOMES.UNCERTAIN,
    ) ||
    !calls.some(
      (call) =>
        call.operation === PUBLIC_CALL_OPERATIONS.VERIFY &&
        call.outcome === PUBLIC_CALL_OUTCOMES.REJECTED,
    )
  )
    throw new GateError(
      GATE_ERROR_CODES.PUBLIC_OUTCOME_UNCERTAIN,
      'Cannot switch facilitator after a possible settlement; reconcile on-chain.',
    );
}
