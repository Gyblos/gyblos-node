// A synthetic ledger behind the x402-upto-metered UptoChain for the upto contract harness: the real
// SDK verifies channel opens offline, while deposits and claims move synthetic balances. Never
// touches a network or real funds.
import { randomBytes } from 'node:crypto';

import {
  UPTO_DEPOSIT_STATES,
  type UptoChain,
  type UptoVerifier,
} from 'x402-upto-metered';

import { PAYMENT_BINDING } from '@gyblos/protocol/constants';
import type { PaymentSettlement } from '@gyblos/protocol/payment';

import {
  CONTRACT_CEILING,
  PAYMENT_EVENTS,
  type PaymentEvent,
} from './payment-rig';
import { UPSTREAM_MARKER } from './private-error';

export const LEDGER_FUNDS = 10n * CONTRACT_CEILING;

export interface UptoLedger {
  now: number;
  balances: { payer: bigint; payee: bigint; treasury: bigint; escrow: bigint };
  events: PaymentEvent[];
  // What the synthetic chain shows for each settlement transaction.
  transactions: Map<string, Omit<PaymentSettlement, 'transaction'>>;
  deposits: Map<string, bigint>;
}

export function newLedger(now: number): UptoLedger {
  return {
    now,
    balances: { payer: LEDGER_FUNDS, payee: 0n, treasury: 0n, escrow: 0n },
    events: [],
    transactions: new Map(),
    deposits: new Map(),
  };
}

// The seller's chain over the ledger: the real offline verify, synthetic deposit and claim. A claim
// pays each recipient its floored share of the signed distribution, like the program.
export function ledgerChain(
  ledger: UptoLedger,
  verify: UptoVerifier,
  options: { failUpstream: boolean; onDepositSent?: () => void },
): UptoChain {
  const claimed = new Map<
    string,
    { chargedAtomic: string; transaction: string }
  >();
  return {
    verify,
    async deposit(authorization) {
      if (options.failUpstream)
        throw new Error(
          `RPC failed at https://rpc.invalid/?k=${UPSTREAM_MARKER}`,
        );
      const ceiling = BigInt(authorization.maxAtomic);
      ledger.balances.payer -= ceiling;
      ledger.balances.escrow += ceiling;
      ledger.deposits.set(authorization.channelId, ceiling);
      ledger.events.push(PAYMENT_EVENTS.DEPOSIT);
      options.onDepositSent?.();
      return { transaction: randomBytes(32).toString('hex') };
    },
    async depositState(channelId) {
      return ledger.deposits.has(channelId)
        ? UPTO_DEPOSIT_STATES.LANDED
        : UPTO_DEPOSIT_STATES.NEVER;
    },
    async claim(record, chargedAtomic) {
      const previous = claimed.get(record.channelId);
      if (previous) return { transaction: previous.transaction };
      const charged = BigInt(chargedAtomic);
      const ceiling = BigInt(record.maxAtomic);
      const denominator = BigInt(PAYMENT_BINDING.bpsDenominator);
      const shares = (record.terms.splits ?? []).map(
        (split) => (charged * BigInt(split.bps)) / denominator,
      );
      const seller = shares[0] ?? charged;
      const fee = shares[1] ?? 0n;
      const transaction = randomBytes(32).toString('hex');
      ledger.balances.escrow -= ceiling;
      ledger.balances.payee += seller;
      ledger.balances.treasury += fee;
      ledger.balances.payer += ceiling - charged;
      ledger.transactions.set(transaction, {
        channelId: record.channelId,
        chargedAtomic,
        refundedAtomic: String(ceiling - charged),
        sellerAtomic: String(seller),
        feeAtomic: String(fee),
      });
      ledger.events.push(PAYMENT_EVENTS.SETTLE);
      claimed.set(record.channelId, { chargedAtomic, transaction });
      return { transaction };
    },
  };
}
