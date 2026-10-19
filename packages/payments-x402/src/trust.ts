import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { PaymentRequirements, SettleResponse } from '@x402/core/types';

import { GateError } from './chain.js';
import { CHANNEL_PROGRAM, DEVNET } from './constants.js';

export interface TrustPolicy {
  mint: string;
  payTo: string;
  feePayer: string;
  receiverAuthorizer: string;
  maxAtomic: string;
}

export function validateSettlement(
  receipt: SettleResponse,
  expected: { payer: string; amount: string },
): void {
  if (
    !receipt.success ||
    receipt.network !== DEVNET ||
    receipt.payer !== expected.payer ||
    receipt.amount !== expected.amount ||
    !receipt.transaction
  )
    throw new GateError(
      'UNTRUSTED_RECEIPT',
      'Settlement receipt does not match expected payer, network and actual amount.',
    );
}

export function validateTerms(
  terms: PaymentRequirements,
  policy: TrustPolicy,
): void {
  const reject = (message: string): never => {
    throw new GateError('UNTRUSTED_TERMS', message);
  };
  if (terms.network !== DEVNET || terms.scheme !== 'upto')
    reject('Wrong network or scheme.');
  if (terms.asset !== policy.mint || terms.payTo !== policy.payTo)
    reject('Wrong asset or recipient.');
  if (
    !/^[1-9]\d*$/.test(terms.amount) ||
    BigInt(terms.amount) > BigInt(policy.maxAtomic)
  )
    reject('Invalid or excessive ceiling.');
  if (
    !Number.isSafeInteger(terms.maxTimeoutSeconds) ||
    terms.maxTimeoutSeconds < 1 ||
    terms.maxTimeoutSeconds > 120
  )
    reject('Unsupported timeout.');
  const extra = terms.extra ?? {};
  if (
    extra.feePayer !== policy.feePayer ||
    extra.receiverAuthorizer !== policy.receiverAuthorizer
  )
    reject('Wrong fee payer or authorizer.');
  if (
    extra.tokenProgram !== undefined &&
    extra.tokenProgram !== TOKEN_PROGRAM_ADDRESS
  )
    reject('Unsupported token program.');
  // The program is a pinned SDK constant, never negotiated from a seller field.
  if ('channelProgram' in extra || 'programId' in extra)
    reject(`Program must be pinned to ${CHANNEL_PROGRAM}.`);
  if (
    typeof extra.withdrawDelay !== 'number' ||
    !Number.isSafeInteger(extra.withdrawDelay) ||
    extra.withdrawDelay < 1 ||
    extra.withdrawDelay > 900
  )
    reject('Unsupported withdrawal delay.');
}
