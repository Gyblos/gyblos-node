// Resolves the buyer's open channels from finalized chain history: a transaction that emptied the
// escrow shows the charge, checked against the buyer's own count; an open that provably never landed
// charged nothing; anything else stays open. Each result is reported before the journal changes.
import {
  createUptoChannelHistory,
  createUptoReceiptReader,
  UPTO_FINAL_COMMITMENT,
  type UptoSignaturesRpc,
  type UptoTransactionRpc,
} from 'x402-upto-metered';

import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';

import type { UptoBuyerJournal, UptoJournalEntry } from './buyer-journal';
import { RECONCILE_OUTCOMES, type NetworkRecoveryBlock } from './constants';
import {
  checkJournalNetwork,
  networkRecoveryBlock,
  snapshotJournal,
} from './journal-network';

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
  // Present when this signed channel cannot be attributed to the selected network.
  networkBlock?: NetworkRecoveryBlock;
}

export interface UptoReconcileOptions {
  journal: UptoBuyerJournal;
  // The network already established by the caller's RPC check.
  network: string;
  rpc: UptoSignaturesRpc & UptoTransactionRpc;
  // The buyer's wallet address and the mint and fee treasury of its policy. Each channel is read with
  // the mint and treasury its open accepted; these only for an entry journaled without them.
  payer: string;
  mint: string;
  treasury: string;
  // The buyer's own count for a request, from its records.
  expected(requestDigest: string): string | undefined;
  // Called with each result before the journal marks it resolved: if it throws, the entry stays open
  // and the next run reports it again, so no resolution goes unrecorded.
  report(result: UptoReconcileResult): Promise<void>;
}

type Signed = UptoJournalEntry & { channelId: string };
type Shown = Pick<
  UptoReconcileResult,
  | 'chargedAtomic'
  | 'sellerAtomic'
  | 'feeAtomic'
  | 'refundedAtomic'
  | 'transaction'
>;
const NOTHING: Shown = {
  chargedAtomic: null,
  sellerAtomic: null,
  feeAtomic: null,
  refundedAtomic: null,
  transaction: null,
};

function readers(options: UptoReconcileOptions) {
  const history = createUptoChannelHistory(options.rpc);
  const receipts = createUptoReceiptReader(options.rpc, UPTO_FINAL_COMMITMENT);

  // Never opened only on the chain's word: the whole history holds no deposit, the open's blockhash had
  // expired by the finalized tip read first (so a late open is already in that history), the account
  // does not exist and the RPC still serves history back to the open's slot.
  async function neverOpened(entry: Signed, tip: bigint, height: bigint) {
    if (height <= BigInt(entry.lastValidBlockHeight)) return false;
    if (await history.accountExists(entry.channelId, tip)) return false;
    return (await history.oldestSlot()) <= BigInt(entry.openSlot);
  }

  return async function shown(
    entry: Signed,
  ): Promise<Shown | 'never' | 'open'> {
    const { slot, height } = await history.tip();
    const { signatures, complete } = await history.signatures(
      entry.channelId,
      slot,
    );
    const { mint, treasury } = entry.policy ?? options;
    let deposited = false;
    for (const transaction of signatures) {
      const found = await receipts.transfer({
        transaction,
        channelId: entry.channelId,
        mint,
        maxAtomic: entry.maxAtomic,
        payer: options.payer,
        payTo: entry.payTo,
        treasury,
      });
      if (found.settled) return { ...found.settled, transaction };
      deposited ||= found.deposited;
    }
    if (deposited || !complete) return 'open';
    return (await neverOpened(entry, slot, height)) ? 'never' : 'open';
  };
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

// Every open, signed entry is read; a resolved one is reported, then written settled with what the
// chain charged, so it no longer blocks payments. Chain, report or journal failures reject.
export async function reconcileUptoBuyer(
  options: UptoReconcileOptions,
): Promise<UptoReconcileResult[]> {
  const rpc = options.rpc;
  const fixed = {
    ...options,
    journal: snapshotJournal(options.journal),
    rpc: {
      getSignaturesForAddress: rpc.getSignaturesForAddress.bind(rpc),
      getEpochInfo: rpc.getEpochInfo.bind(rpc),
      minimumLedgerSlot: rpc.minimumLedgerSlot.bind(rpc),
      getFirstAvailableBlock: rpc.getFirstAvailableBlock.bind(rpc),
      getAccountInfo: rpc.getAccountInfo.bind(rpc),
      getTransaction: rpc.getTransaction.bind(rpc),
    },
  };
  checkJournalNetwork(fixed.network);
  const entries = (await fixed.journal.list()).map((entry) => ({
    ...entry,
    policy: entry.policy ? { ...entry.policy } : null,
  }));
  const shown = readers(fixed);
  const results: UptoReconcileResult[] = [];
  for (const entry of entries) {
    const { channelId, updatedAt: _updatedAt, ...rest } = entry;
    if (!channelId || entry.state !== PAYMENT_CHANNEL_STATES.OPEN) continue;
    const expectedAtomic = fixed.expected(entry.requestDigest) ?? null;
    const base = {
      requestDigest: entry.requestDigest,
      channelId,
      expectedAtomic,
    };
    const networkBlock = networkRecoveryBlock(entry, fixed.network);
    if (networkBlock) {
      const open = {
        ...base,
        outcome: RECONCILE_OUTCOMES.OPEN,
        ...NOTHING,
        networkBlock,
      };
      await fixed.report(open);
      results.push(open);
      continue;
    }
    const chain = await shown({ ...entry, channelId });
    if (chain === 'open') {
      const open = { ...base, outcome: RECONCILE_OUTCOMES.OPEN, ...NOTHING };
      await fixed.report(open);
      results.push(open);
      continue;
    }
    const settled =
      chain === 'never' ? { ...NOTHING, chargedAtomic: '0' } : chain;
    const charged = settled.chargedAtomic ?? '0';
    const result = {
      ...base,
      ...settled,
      outcome:
        chain === 'never'
          ? RECONCILE_OUTCOMES.NEVER_OPENED
          : outcomeOf(expectedAtomic, charged),
    };
    await fixed.report(result);
    await fixed.journal.put({
      ...rest,
      channelId,
      state: PAYMENT_CHANNEL_STATES.SETTLED,
      chargedAtomic: charged,
    });
    results.push(result);
  }
  return results;
}
