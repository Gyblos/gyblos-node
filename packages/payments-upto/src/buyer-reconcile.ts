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

import { TIMEOUTS } from '@gyblos/config';
import {
  PAYMENT_CHANNEL_STATES,
  PUBLIC_RECORD_LIMITS,
} from '@gyblos/protocol/constants';

import type { UptoBuyerJournal, UptoJournalEntry } from './buyer-journal';
import { beforeAbort, observationRpc } from './buyer-observation-rpc';
import {
  RECONCILE_OUTCOMES,
  UPTO_BUYER_DISTINCT_PARTIES,
  type NetworkRecoveryBlock,
} from './constants';
import {
  checkJournalNetwork,
  networkRecoveryBlock,
  snapshotJournal,
  snapshotJournalEntry,
} from './journal-network';
import { assertPaymentNetworkEnabled } from './mainnet';
import { verifyPaymentNetwork, type PaymentGenesisRpc } from './seller-network';

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
  rpc: UptoSignaturesRpc & UptoTransactionRpc & PaymentGenesisRpc;
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

export interface UptoChargeObservation {
  chargedAtomic: string;
  refundedAtomic: string;
}

export async function observeUptoBuyer(
  options: Omit<UptoReconcileOptions, 'report' | 'expected'> & {
    requestDigest: string;
    signal?: AbortSignal;
  },
): Promise<UptoChargeObservation | undefined> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(TIMEOUTS.rpc),
    ...(options.signal ? [options.signal] : []),
  ]);
  const fixed = {
    network: options.network,
    payer: options.payer,
    mint: options.mint,
    treasury: options.treasury,
    requestDigest: options.requestDigest,
    signal,
    journal: snapshotJournal(options.journal),
    rpc: observationRpc(snapshotRpc(options.rpc), signal),
  };
  assertPaymentNetworkEnabled(fixed.network);
  checkJournalNetwork(fixed.network);
  if (!/^[0-9a-f]{64}$/.test(fixed.requestDigest)) return undefined;
  fixed.signal?.throwIfAborted();
  const found = await beforeAbort(signal, () =>
    fixed.journal.get(fixed.requestDigest),
  );
  fixed.signal?.throwIfAborted();
  if (!found) return undefined;
  const entry = snapshotJournalEntry(found);
  if (
    entry.requestDigest !== fixed.requestDigest ||
    !entry.channelId ||
    networkRecoveryBlock(entry, fixed.network) ||
    !entry.policy ||
    new Set([fixed.payer, entry.payTo, entry.feePayer, entry.policy.treasury])
      .size !== UPTO_BUYER_DISTINCT_PARTIES
  )
    return undefined;
  await verifyPaymentNetwork(fixed.rpc, fixed.network);
  fixed.signal?.throwIfAborted();
  const shown = await readers(
    fixed,
    true,
  )({ ...entry, channelId: entry.channelId });
  fixed.signal?.throwIfAborted();
  if (
    shown === 'open' ||
    shown === 'never' ||
    shown.chargedAtomic === null ||
    shown.refundedAtomic === null ||
    shown.transaction === null
  )
    return undefined;
  if (
    !/^(0|[1-9][0-9]{0,19})$/.test(shown.chargedAtomic) ||
    !/^(0|[1-9][0-9]{0,19})$/.test(shown.refundedAtomic) ||
    BigInt(shown.chargedAtomic) > BigInt(PUBLIC_RECORD_LIMITS.maxAtomic) ||
    BigInt(shown.refundedAtomic) > BigInt(PUBLIC_RECORD_LIMITS.maxAtomic) ||
    BigInt(shown.chargedAtomic) + BigInt(shown.refundedAtomic) !==
      BigInt(entry.maxAtomic)
  )
    return undefined;
  return {
    chargedAtomic: shown.chargedAtomic,
    refundedAtomic: shown.refundedAtomic,
  };
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

function readers(
  options: Pick<UptoReconcileOptions, 'rpc' | 'payer' | 'mint' | 'treasury'>,
  requireComplete = false,
) {
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
      if (found.settled)
        return requireComplete && !complete
          ? 'open'
          : { ...found.settled, transaction };
      deposited ||= found.deposited;
    }
    if (deposited || !complete || requireComplete) return 'open';
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

// A caller cannot swap the RPC methods between verifying genesis and reading history.
function snapshotRpc(
  rpc: UptoReconcileOptions['rpc'],
): UptoReconcileOptions['rpc'] {
  return {
    getGenesisHash: rpc.getGenesisHash.bind(rpc),
    getSignaturesForAddress: rpc.getSignaturesForAddress.bind(rpc),
    getEpochInfo: rpc.getEpochInfo.bind(rpc),
    minimumLedgerSlot: rpc.minimumLedgerSlot.bind(rpc),
    getFirstAvailableBlock: rpc.getFirstAvailableBlock.bind(rpc),
    getAccountInfo: rpc.getAccountInfo.bind(rpc),
    getTransaction: rpc.getTransaction.bind(rpc),
  };
}

// Every open, signed entry is read; a resolved one is reported, then written settled with what the
// chain charged, so it no longer blocks payments. Chain, report or journal failures reject.
export async function reconcileUptoBuyer(
  options: UptoReconcileOptions,
): Promise<UptoReconcileResult[]> {
  const network = options.network;
  assertPaymentNetworkEnabled(network);
  const fixed: UptoReconcileOptions = {
    network,
    journal: snapshotJournal(options.journal),
    payer: options.payer,
    mint: options.mint,
    treasury: options.treasury,
    expected: options.expected.bind(options),
    report: options.report.bind(options),
    rpc: snapshotRpc(options.rpc),
  };
  checkJournalNetwork(fixed.network);
  const entries = (await fixed.journal.list()).map(snapshotJournalEntry);
  const shown = readers(fixed);
  const results: UptoReconcileResult[] = [];
  let verified = false;
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
    if (!verified) {
      await verifyPaymentNetwork(fixed.rpc, fixed.network);
      verified = true;
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
