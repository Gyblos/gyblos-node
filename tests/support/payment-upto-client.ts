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

// How the memory journal fails: never, on every write, on reads, or on the write after signing.
export const JOURNAL_FAULTS = {
  NONE: 'none',
  WRITES: 'writes',
  READS: 'reads',
  SIGNED_WRITE: 'signed-write',
  // The write after signing lands but still reports failure.
  SIGNED_WRITE_LANDS: 'signed-write-lands',
} as const;
export type JournalFault = (typeof JOURNAL_FAULTS)[keyof typeof JOURNAL_FAULTS];

// Reports the first write of each request (before its signature) as the contract's journal event.
export function memoryJournal(
  ledger: UptoLedger,
  fault: JournalFault,
  now: () => number,
): UptoBuyerJournal & { entries: Map<string, UptoJournalEntry> } {
  const entries = new Map<string, UptoJournalEntry>();
  const read = () => {
    if (fault === JOURNAL_FAULTS.READS) throw new Error('journal unavailable');
  };
  return {
    entries,
    async get(requestDigest) {
      read();
      return entries.get(requestDigest);
    },
    async put(entry) {
      if (
        fault === JOURNAL_FAULTS.WRITES ||
        (fault === JOURNAL_FAULTS.SIGNED_WRITE && entry.channelId !== null)
      )
        throw new Error('journal unavailable');
      if (!entries.has(entry.requestDigest))
        ledger.events.push(PAYMENT_EVENTS.JOURNAL);
      entries.set(entry.requestDigest, { ...entry, updatedAt: now() });
      if (
        fault === JOURNAL_FAULTS.SIGNED_WRITE_LANDS &&
        entry.channelId !== null
      )
        throw new Error('sync failed after rename');
    },
    async remove(requestDigest) {
      if (entries.get(requestDigest)?.channelId) throw new Error('signed');
      entries.delete(requestDigest);
    },
    async list() {
      read();
      return [...entries.values()];
    },
    close: async () => {},
  };
}

export function observedSigner(
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
    journal: memoryJournal(
      ledger,
      options.failJournal ? JOURNAL_FAULTS.WRITES : JOURNAL_FAULTS.NONE,
      () => ledger.now,
    ),
    confirm: async (settlement) =>
      ledger.transactions.get(settlement.transaction),
    now: () => ledger.now,
  });
}
