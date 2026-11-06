// Records a recovered close only after a trusted reader proves actual finalized token flows.
// This action signs metadata only; it never signs, submits, or retries a payment transaction.
import {
  createSignableMessage,
  getBase58Decoder,
  isAddress,
} from '@solana/kit';
import type { BatchClientSigner } from '@x402/svm/batch-settlement/client';
import { uptoTokenAccount } from 'x402-upto-metered';

import { CHANNEL_PROGRAM } from '@gyblos/config';

import { REUSABLE_JOURNAL_STATES } from './constants';
import { closureRedirected } from './reusable-journal-closure-model';
import { closureMessage } from './reusable-journal-crypto';
import {
  atomic,
  unavailable,
  type ClosedChannelObservation,
  type ReusableChannelEntry,
  type ReusableChannelTerms,
  type ReusableClosureRecord,
} from './reusable-journal-model';
import { findChannel } from './reusable-journal-observation';
import type { ReusableJournalStore } from './reusable-journal-store';

async function checkedClosure(
  terms: ReusableChannelTerms,
  entry: ReusableChannelEntry,
  found: ClosedChannelObservation,
  programTreasuryOwner: string,
): Promise<Omit<ReusableClosureRecord, 'signature'>> {
  if (
    !found ||
    found.finalized !== true ||
    found.network !== terms.network ||
    found.program !== CHANNEL_PROGRAM ||
    !isAddress(programTreasuryOwner) ||
    found.programTreasuryOwner !== programTreasuryOwner ||
    found.escrowTokenAccount !==
      (await uptoTokenAccount(
        terms.channelId,
        terms.mint,
        terms.tokenProgram,
      )) ||
    found.channelId !== terms.channelId ||
    found.mint !== terms.mint ||
    found.buyer !== terms.buyer ||
    found.payTo !== terms.payTo ||
    found.treasury !== terms.treasury ||
    found.buyerRefundOwner !== terms.buyer ||
    found.historyComplete !== true ||
    BigInt(atomic(found.historyFromSlot)) > BigInt(terms.openSlot) ||
    atomic(found.historyThroughSlot) !== atomic(found.finalizedTipSlot) ||
    BigInt(found.finalizedTipSlot) < BigInt(entry.lastObservedSlot) ||
    BigInt(found.finalizedTipSlot) < BigInt(terms.openSlot) ||
    found.channelClosed !== true ||
    atomic(found.escrowBalanceAtomic) !== '0' ||
    atomic(found.depositedAtomic) !== terms.depositAtomic
  )
    unavailable();
  const evidence = {
    contextSlot: found.finalizedTipSlot,
    escrowTokenAccount: found.escrowTokenAccount,
    programTreasuryOwner,
    settledAtomic: atomic(found.settledAtomic),
    sellerReceivedAtomic: atomic(found.sellerReceivedAtomic),
    treasuryReceivedAtomic: atomic(found.treasuryReceivedAtomic),
    programResidualAtomic: atomic(found.programResidualAtomic),
    buyerRefundAtomic: atomic(found.buyerRefundAtomic),
    buyerRefundRedirectedAtomic: atomic(found.buyerRefundRedirectedAtomic),
    sellerRedirectedAtomic: atomic(found.sellerRedirectedAtomic),
    treasuryRedirectedAtomic: atomic(found.treasuryRedirectedAtomic),
  };
  closureRedirected(
    terms,
    entry.authorizedAtomic,
    entry.pending,
    entry.vouchers,
    evidence,
  );
  if (
    atomic(found.redirectedAtomic) !==
    String(
      BigInt(evidence.buyerRefundRedirectedAtomic) +
        BigInt(evidence.sellerRedirectedAtomic) +
        BigInt(evidence.treasuryRedirectedAtomic),
    )
  )
    unavailable();
  return evidence;
}

export function createClosureActions(store: ReusableJournalStore) {
  return {
    recoverClosedChannel(
      channelId: string,
      read: (terms: ReusableChannelTerms) => Promise<ClosedChannelObservation>,
      signer: BatchClientSigner,
      // Must come from trusted local network policy, never from a seller or observation.
      policy: { programTreasuryOwner: string },
    ): Promise<void> {
      return store.run(async ({ entries, save }) => {
        const entry = findChannel(entries, channelId);
        const terms = entry.terms;
        if (
          (entry.status !== REUSABLE_JOURNAL_STATES.READY &&
            entry.status !== REUSABLE_JOURNAL_STATES.OPENING) ||
          signer.address !== terms.buyer
        )
          unavailable();
        const found = await read(structuredClone(terms));
        const evidence = await checkedClosure(
          terms,
          entry,
          found,
          policy.programTreasuryOwner,
        );
        const [signature] = await signer.signMessages([
          createSignableMessage(closureMessage(terms, evidence)),
        ]);
        const bytes = signature?.[signer.address];
        if (!bytes) unavailable();
        entry.closure = {
          ...evidence,
          signature: getBase58Decoder().decode(bytes),
        };
        entry.lastObservedSlot = evidence.contextSlot;
        entry.status =
          evidence.buyerRefundRedirectedAtomic === '0' &&
          evidence.sellerRedirectedAtomic === '0' &&
          evidence.treasuryRedirectedAtomic === '0'
            ? REUSABLE_JOURNAL_STATES.CLOSED
            : REUSABLE_JOURNAL_STATES.CLOSED_REDIRECTED;
        await save();
      });
    },
  };
}
