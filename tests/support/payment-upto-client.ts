// The production upto PaymentClient wired for the payment contract: a memory journal and a payer signer
// that report journal writes and signatures as contract events, and a settlement view over the
// synthetic ledger. Hints are fixed; no network.
import type { KeyPairSigner, TransactionSigner } from '@solana/kit';
import type { UptoClientHints } from 'x402-upto-metered';

import {
  createUptoPaymentClient,
  type UptoBuyerJournal,
  type UptoBuyerPolicy,
  type UptoChannelSettings,
  type UptoJournalEntry,
} from '@gyblos/payments-upto';
import type { PaymentClient } from '@gyblos/protocol/payment';

import { PAYMENT_EVENTS } from './payment-rig';
import type { UptoLedger } from './payment-upto-ledger';

// Reports the first write of each request (before its signature) as the contract's journal event.
function memoryJournal(ledger: UptoLedger, fail: boolean): UptoBuyerJournal {
  const entries = new Map<string, UptoJournalEntry>();
  return {
    get: async (requestDigest) => entries.get(requestDigest),
    async put(entry) {
      if (fail) throw new Error('journal unavailable');
      if (!entries.has(entry.requestDigest))
        ledger.events.push(PAYMENT_EVENTS.JOURNAL);
      entries.set(entry.requestDigest, { ...entry });
    },
    list: async () => [...entries.values()],
    close: async () => {},
  };
}

function observedSigner(
  payer: KeyPairSigner,
  ledger: UptoLedger,
): TransactionSigner {
  return {
    address: payer.address,
    async signTransactions(transactions, config) {
      ledger.events.push(PAYMENT_EVENTS.SIGN);
      return payer.signTransactions(transactions, config);
    },
  };
}

export function uptoContractClient(options: {
  payer: KeyPairSigner;
  policy: Omit<UptoBuyerPolicy, 'maxAtomic'>;
  maxAtomic: bigint;
  settings: UptoChannelSettings;
  hints: UptoClientHints;
  ledger: UptoLedger;
  failJournal: boolean;
}): PaymentClient {
  const { ledger } = options;
  return createUptoPaymentClient({
    payer: observedSigner(options.payer, ledger),
    policy: { ...options.policy, maxAtomic: String(options.maxAtomic) },
    settings: options.settings,
    hints: async () => options.hints,
    journal: memoryJournal(ledger, options.failJournal),
    confirm: async (settlement) =>
      ledger.transactions.get(settlement.transaction),
    now: () => ledger.now,
  });
}
