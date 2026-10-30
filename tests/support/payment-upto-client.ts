// A test-only PaymentClient over x402-upto-metered: it checks terms against the buyer's policy,
// journals before signing, signs the real channel open with the SDK client, and checks receipts on
// the synthetic ledger. The paying buyer (C3) replaces it.
import type { KeyPairSigner } from '@solana/kit';
import {
  createUptoAuthorization,
  type UptoClientHints,
} from 'x402-upto-metered';

import { uptoTermsFor, type UptoChannelSettings } from '@gyblos/payments-upto';
import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
  type PaymentErrorCode,
} from '@gyblos/protocol/constants';
import {
  PaymentError,
  type PaymentAuthorization,
  type PaymentClient,
  type PaymentReconciliation,
  type PaymentTerms,
} from '@gyblos/protocol/payment';

import { CONTRACT_CEILING, PAYMENT_EVENTS } from './payment-rig';
import type { UptoLedger } from './payment-upto-ledger';

const ATOMIC = /^(0|[1-9][0-9]*)$/;
const DIGEST = /^[0-9a-f]{64}$/;

export interface UptoBuyerPolicy {
  network: string;
  mint: string;
  protocolFeeBps: number;
  treasury: string;
}

interface JournalEntry extends PaymentReconciliation {
  maxAtomic: string;
}

function fail(code: PaymentErrorCode): never {
  throw new PaymentError(code);
}

function trusted(
  terms: PaymentTerms,
  policy: UptoBuyerPolicy,
  payer: string,
  now: number,
) {
  return (
    terms.network === policy.network &&
    terms.mint === policy.mint &&
    terms.protocolFeeBps === policy.protocolFeeBps &&
    terms.treasury === policy.treasury &&
    terms.buyer === payer &&
    ATOMIC.test(terms.maxAtomic) &&
    BigInt(terms.maxAtomic) > 0n &&
    BigInt(terms.maxAtomic) <= CONTRACT_CEILING &&
    DIGEST.test(terms.requestDigest) &&
    terms.expiresAt > now
  );
}

export function uptoTestClient(options: {
  payer: KeyPairSigner;
  policy: UptoBuyerPolicy;
  settings: UptoChannelSettings;
  hints: UptoClientHints;
  ledger: UptoLedger;
  failJournal: boolean;
}): PaymentClient {
  const { payer, ledger } = options;
  const journal = new Map<string, JournalEntry>();
  return {
    async authorize(terms) {
      if (!trusted(terms, options.policy, payer.address, ledger.now))
        fail(PAYMENT_ERROR_CODES.UNTRUSTED_TERMS);
      if (journal.has(terms.requestDigest))
        fail(PAYMENT_ERROR_CODES.ALREADY_AUTHORIZED);
      if (options.failJournal) fail(PAYMENT_ERROR_CODES.JOURNAL_UNAVAILABLE);
      // Reserved synchronously, before any await, so a concurrent call sees it.
      const entry: JournalEntry = {
        channelId: '',
        requestDigest: terms.requestDigest,
        state: PAYMENT_CHANNEL_STATES.OPEN,
        chargedAtomic: null,
        maxAtomic: terms.maxAtomic,
      };
      journal.set(terms.requestDigest, entry);
      ledger.events.push(PAYMENT_EVENTS.JOURNAL);
      const signed = await createUptoAuthorization(
        payer,
        await uptoTermsFor(terms, options.settings),
        options.hints,
      );
      ledger.events.push(PAYMENT_EVENTS.SIGN);
      entry.channelId = signed.channelId;
      return { ...signed, requestDigest: terms.requestDigest };
    },
    async checkReceipt(authorization, settlement, expectedChargedAtomic) {
      const entry = journal.get(authorization.requestDigest);
      if (!entry || entry.channelId !== authorization.channelId)
        fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
      if (entry.state === PAYMENT_CHANNEL_STATES.SETTLED)
        fail(PAYMENT_ERROR_CODES.ALREADY_SETTLED);
      const onChain = ledger.transactions.get(settlement.transaction);
      if (
        !onChain ||
        onChain.channelId !== entry.channelId ||
        settlement.channelId !== entry.channelId ||
        onChain.chargedAtomic !== settlement.chargedAtomic ||
        onChain.refundedAtomic !== settlement.refundedAtomic ||
        onChain.sellerAtomic !== settlement.sellerAtomic ||
        onChain.feeAtomic !== settlement.feeAtomic ||
        settlement.chargedAtomic !== expectedChargedAtomic ||
        BigInt(onChain.chargedAtomic) + BigInt(onChain.refundedAtomic) !==
          BigInt(entry.maxAtomic)
      )
        fail(PAYMENT_ERROR_CODES.RECEIPT_MISMATCH);
      entry.state = PAYMENT_CHANNEL_STATES.SETTLED;
      entry.chargedAtomic = settlement.chargedAtomic;
    },
    async reconcile() {
      return [...journal.values()].map(
        ({ channelId, requestDigest, state, chargedAtomic }) => ({
          channelId,
          requestDigest,
          state,
          chargedAtomic,
        }),
      );
    },
  };
}

// Kept for the harness: the authorization a client produced, by request digest.
export type SignedAuthorizations = Map<string, PaymentAuthorization>;
