// Resolves the buyer's open channels from finalized chain history: an address no transaction touched,
// once its open can no longer land, was never opened (nothing charged); a transaction that emptied the
// escrow shows the charge, checked against the buyer's own count. Anything else stays open.
import {
  createUptoChannelHistory,
  createUptoReceiptReader,
  UPTO_FINAL_COMMITMENT,
  type UptoSignaturesRpc,
  type UptoTransactionRpc,
} from 'x402-upto-metered';

import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import type { UptoBuyerJournal, UptoJournalEntry } from './buyer-journal';
import { BUYER_RECONCILE, RECONCILE_OUTCOMES } from './constants';

export type UptoReconcileOutcome =
  (typeof RECONCILE_OUTCOMES)[keyof typeof RECONCILE_OUTCOMES];

export interface UptoReconcileResult {
  requestDigest: string;
  channelId: string;
  outcome: UptoReconcileOutcome;
  // The buyer's own count, when a record of it survived.
  expectedAtomic: string | null;
  // What the chain shows charged; null while the channel stays open.
  chargedAtomic: string | null;
  sellerAtomic: string | null;
  feeAtomic: string | null;
  refundedAtomic: string | null;
  transaction: string | null;
}

export interface UptoReconcileOptions {
  journal: UptoBuyerJournal;
  rpc: UptoSignaturesRpc & UptoTransactionRpc;
  // The buyer's wallet address and the mint and fee treasury of its policy.
  payer: string;
  mint: string;
  treasury: string;
  // The buyer's own count for a request, from its records.
  expected(requestDigest: string): string | undefined;
  now: () => number;
}

type Shown = Omit<
  UptoReconcileResult,
  'requestDigest' | 'channelId' | 'expectedAtomic' | 'outcome'
>;
const OPEN: Shown = {
  chargedAtomic: null,
  sellerAtomic: null,
  feeAtomic: null,
  refundedAtomic: null,
  transaction: null,
};

async function shown(
  entry: UptoJournalEntry & { channelId: string },
  options: UptoReconcileOptions,
): Promise<Shown | 'never' | 'open'> {
  const history = createUptoChannelHistory(options.rpc);
  const reader = createUptoReceiptReader(options.rpc, UPTO_FINAL_COMMITMENT);
  const signatures = await history.signatures(entry.channelId);
  if (!signatures.length)
    // Signed when the entry was last written; its blockhash has long expired after the window.
    return options.now() - entry.updatedAt > BUYER_RECONCILE.openLandMs
      ? 'never'
      : 'open';
  for (const transaction of signatures) {
    const found = await reader.settlement({
      transaction,
      channelId: entry.channelId,
      mint: options.mint,
      maxAtomic: entry.maxAtomic,
      payer: options.payer,
      payTo: entry.payTo,
      treasury: options.treasury,
    });
    if (found)
      return {
        chargedAtomic: found.chargedAtomic,
        sellerAtomic: found.sellerAtomic,
        feeAtomic: found.feeAtomic,
        refundedAtomic: found.refundedAtomic,
        transaction,
      };
  }
  return 'open';
}

function outcomeOf(
  expected: string | null,
  charged: string,
): UptoReconcileOutcome {
  if (expected === null) return RECONCILE_OUTCOMES.UNCHECKED;
  return expected === charged
    ? RECONCILE_OUTCOMES.SETTLED
    : RECONCILE_OUTCOMES.DISPUTED;
}

// Every open, signed entry is read; a resolved one is written settled with what the chain charged,
// so it no longer blocks payments. Chain or journal failures reject; nothing is guessed.
export async function reconcileUptoBuyer(
  options: UptoReconcileOptions,
): Promise<UptoReconcileResult[]> {
  const results: UptoReconcileResult[] = [];
  for (const entry of await options.journal.list()) {
    const { channelId, updatedAt: _updatedAt, ...rest } = entry;
    if (!channelId || entry.state !== PAYMENT_CHANNEL_STATES.OPEN) continue;
    const expectedAtomic = options.expected(entry.requestDigest) ?? null;
    const base = {
      requestDigest: entry.requestDigest,
      channelId,
      expectedAtomic,
    };
    const chain = await shown({ ...entry, channelId }, options);
    if (chain === 'open') {
      results.push({ ...base, outcome: RECONCILE_OUTCOMES.OPEN, ...OPEN });
      continue;
    }
    const settled = chain === 'never' ? { ...OPEN, chargedAtomic: '0' } : chain;
    const charged = settled.chargedAtomic ?? '0';
    await options.journal.put({
      ...rest,
      channelId,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: charged,
    });
    results.push({
      ...base,
      ...settled,
      outcome:
        chain === 'never'
          ? RECONCILE_OUTCOMES.NEVER_OPENED
          : outcomeOf(expectedAtomic, charged),
    });
  }
  return results;
}
