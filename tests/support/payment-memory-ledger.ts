// Shared pieces of the in-memory payment reference: the synthetic ledger, fee policy, signing
// bytes and the checks both parties apply. Test support only; never moves funds.
import { createHash } from 'node:crypto';

import {
  PAYMENT_ERROR_CODES,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAdmission,
  type PaymentDescription,
  type PaymentReconciliation,
  type PaymentSettlement,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import {
  CONTRACT_CEILING,
  type PaymentBalances,
  type PaymentEvent,
} from './payment-rig';

export const ATOMIC = /^(0|[1-9][0-9]*)$/;
export const DIGEST = /^[0-9a-f]{64}$/;
export const FUNDS = 10n * CONTRACT_CEILING;
export const TERM_MS = 60_000;
// Synthetic start of the rig clock (epoch ms); a real harness may start at real time.
export const START_MS = 1_800_000_000_000;
export const NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const MINT = 'mint-synthetic';
// The network fee policy both parties hold; terms naming anything else are refused.
export const FEE = { protocolFeeBps: 300, treasury: 'treasury-synthetic' };

export interface Ledger {
  // The synthetic clock both parties read; only the rig's advance() moves it.
  now: number;
  balances: PaymentBalances;
  events: PaymentEvent[];
  // What actually happened on the synthetic chain, by transaction id.
  transactions: Map<string, Omit<PaymentSettlement, 'transaction'>>;
}

export interface JournalEntry extends PaymentReconciliation {
  maxAtomic: string;
}

export interface Channel extends PaymentAdmission {
  settlement: PaymentSettlement | null;
}

export function fail(code: PaymentErrorCode): never {
  throw new PaymentError(code);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function description(name: string): PaymentDescription {
  return {
    network: NETWORK,
    mint: MINT,
    payTo: `payee-${name}`,
    feePayer: `fee-payer-${name}`,
    authorizer: `authorizer-${name}`,
    ...FEE,
  };
}

// A second seller whose every declared field differs from description('primary').
export const OTHER_SELLER: PaymentDescription = {
  ...description('other'),
  protocolFeeBps: FEE.protocolFeeBps + 1,
  treasury: 'treasury-other',
};

export function channelIdOf(payer: string, terms: PaymentTerms): string {
  return sha256(JSON.stringify([payer, terms.payTo, terms.requestDigest]));
}

// Everything a payer signs: the channel and every money-binding field of the terms.
export function signedBytes(channelId: string, terms: PaymentTerms): Buffer {
  return Buffer.from(
    JSON.stringify([
      channelId,
      terms.buyer,
      terms.network,
      terms.mint,
      terms.payTo,
      terms.feePayer,
      terms.authorizer,
      terms.requestDigest,
      terms.maxAtomic,
      terms.expiresAt,
      terms.protocolFeeBps,
      terms.treasury,
    ]),
  );
}

export function trustedTerms(
  terms: PaymentTerms,
  payer: string,
  now: number,
): boolean {
  return (
    terms.network === NETWORK &&
    terms.mint === MINT &&
    terms.protocolFeeBps === FEE.protocolFeeBps &&
    terms.treasury === FEE.treasury &&
    terms.buyer === payer &&
    ATOMIC.test(terms.maxAtomic) &&
    BigInt(terms.maxAtomic) > 0n &&
    BigInt(terms.maxAtomic) <= CONTRACT_CEILING &&
    DIGEST.test(terms.requestDigest) &&
    terms.expiresAt > now
  );
}

export function confirmedReceipt(
  ledger: Ledger,
  entry: JournalEntry,
  settlement: PaymentSettlement,
  expectedChargedAtomic: string,
): boolean {
  const onChain = ledger.transactions.get(settlement.transaction);
  return (
    onChain !== undefined &&
    onChain.channelId === entry.channelId &&
    settlement.channelId === entry.channelId &&
    onChain.chargedAtomic === settlement.chargedAtomic &&
    onChain.refundedAtomic === settlement.refundedAtomic &&
    settlement.chargedAtomic === expectedChargedAtomic &&
    BigInt(onChain.chargedAtomic) + BigInt(onChain.refundedAtomic) ===
      BigInt(entry.maxAtomic)
  );
}
