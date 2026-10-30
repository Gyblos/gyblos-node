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
  type PaymentClient,
  type PaymentReconciliation,
} from '@gyblos/protocol/payment';

import {
  buyerTrusts,
  ledgerConfirms,
  PAYMENT_EVENTS,
  type BuyerPolicy,
} from './payment-rig';
import type { UptoLedger } from './payment-upto-ledger';

interface JournalEntry extends PaymentReconciliation {
  maxAtomic: string;
}

function fail(code: PaymentErrorCode): never {
  throw new PaymentError(code);
}

export function uptoTestClient(options: {
  payer: KeyPairSigner;
  policy: BuyerPolicy;
  settings: UptoChannelSettings;
  hints: UptoClientHints;
  ledger: UptoLedger;
  failJournal: boolean;
}): PaymentClient {
  const { payer, ledger } = options;
  const journal = new Map<string, JournalEntry>();
  return {
    async authorize(terms) {
      if (!buyerTrusts(terms, options.policy, payer.address, ledger.now))
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
      if (
        !ledgerConfirms(
          ledger.transactions.get(settlement.transaction),
          entry,
          settlement,
          expectedChargedAtomic,
        )
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
