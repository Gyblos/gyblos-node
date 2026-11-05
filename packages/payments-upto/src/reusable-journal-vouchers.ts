// Reserves each cumulative amount before signing and records both signatures before returning it.
// Does not verify delivery, authorize a prompt, contact peers or execute payments.
import { createSignableMessage, getBase58Decoder } from '@solana/kit';
import {
  signBatchVoucher,
  type BatchClientSigner,
} from '@x402/svm/batch-settlement/client';

import { PUBLIC_RECORD_LIMITS } from '@gyblos/protocol/constants';

import { REUSABLE_JOURNAL, REUSABLE_JOURNAL_STATES } from './constants';
import { assertPaymentNetworkEnabled } from './mainnet';
import { bindingMessage } from './reusable-journal-crypto';
import {
  atomic,
  digest,
  unavailable,
  type FinalizedOpenObservation,
  type ReusableChannelEntry,
  type ReusableChannelTerms,
} from './reusable-journal-model';
import { findChannel, verifyObservation } from './reusable-journal-observation';
import type {
  ReusableJournalSession,
  ReusableJournalStore,
} from './reusable-journal-store';

export type ReusableObservationReader = (
  terms: ReusableChannelTerms,
) => Promise<FinalizedOpenObservation>;
export type SignedReusableVoucher = Awaited<
  ReturnType<typeof signBatchVoucher>
>;

function ensureRoom(
  session: ReusableJournalSession,
  channelId: string,
  requestDigest: string,
  amount: string,
): void {
  const draft = structuredClone(session.entries);
  const entry = findChannel(draft, channelId);
  const placeholder = '1'.repeat(REUSABLE_JOURNAL.signatureChars);
  entry.lastObservedSlot = PUBLIC_RECORD_LIMITS.maxAtomic;
  entry.authorizedAtomic = amount;
  entry.pending = null;
  entry.vouchers.push({
    requestDigest,
    maxClaimableAmount: amount,
    signature: placeholder,
    bindingSignature: placeholder,
  });
  const source = JSON.stringify({
    version: REUSABLE_JOURNAL.version,
    entries: draft,
  });
  if (Buffer.byteLength(source) > session.maxBytes) unavailable();
}
async function signPending(
  session: ReusableJournalSession,
  entry: ReusableChannelEntry,
  signer: BatchClientSigner,
): Promise<SignedReusableVoucher> {
  const pending = entry.pending;
  if (!pending || signer.address !== entry.terms.buyer) return unavailable();
  const signed = await signBatchVoucher(signer, {
    channelId: entry.terms.channelId,
    maxClaimableAmount: BigInt(pending.maxClaimableAmount),
    expiresAt: 0,
  });
  entry.vouchers.push({ ...pending, signature: signed.signature });
  entry.pending = null;
  await session.save();
  return signed;
}
function knownSettlement(entry: ReusableChannelEntry, amount: string): boolean {
  return (
    amount === '0' ||
    entry.vouchers.some((voucher) => voucher.maxClaimableAmount === amount)
  );
}
// A signature may have escaped before interruption; do not sign it again.
function recoverPending(): Promise<SignedReusableVoucher> {
  return Promise.resolve().then(unavailable);
}

export function createReusableVoucherActions(store: ReusableJournalStore) {
  return {
    issueVoucher(
      channelId: string,
      requestId: string,
      amount: string,
      signer: BatchClientSigner,
      read: ReusableObservationReader,
    ): Promise<SignedReusableVoucher> {
      const requestDigest = digest(requestId);
      const cumulative = atomic(amount);
      return store.run(async (session) => {
        const { entries } = session;
        const entry = findChannel(entries, channelId);
        assertPaymentNetworkEnabled(entry.terms.network);
        if (
          entry.status !== REUSABLE_JOURNAL_STATES.READY ||
          signer.address !== entry.terms.buyer ||
          entry.vouchers.length >= REUSABLE_JOURNAL.maxVouchersPerChannel ||
          entries.some(
            (row) =>
              row.pending !== null ||
              row.status === REUSABLE_JOURNAL_STATES.OPENING ||
              row.status === REUSABLE_JOURNAL_STATES.PREPARING,
          ) ||
          entries.some((row) =>
            row.vouchers.some((item) => item.requestDigest === requestDigest),
          ) ||
          BigInt(cumulative) <= BigInt(entry.authorizedAtomic) ||
          BigInt(cumulative) > BigInt(entry.terms.depositAtomic)
        )
          unavailable();
        ensureRoom(session, channelId, requestDigest, cumulative);
        const observed = await read(structuredClone(entry.terms));
        verifyObservation(
          entry.terms,
          observed,
          entry.authorizedAtomic,
          entry.lastObservedSlot,
        );
        if (
          !knownSettlement(entry, observed.settledAtomic) ||
          !knownSettlement(entry, observed.paidAtomic)
        )
          unavailable();
        entry.lastObservedSlot = observed.contextSlot;
        const intent = { requestDigest, maxClaimableAmount: cumulative };
        const [binding] = await signer.signMessages([
          createSignableMessage(bindingMessage(entry.terms, intent)),
        ]);
        const bytes = binding?.[signer.address];
        if (!bytes) unavailable();
        entry.pending = {
          ...intent,
          bindingSignature: getBase58Decoder().decode(bytes),
        };
        entry.authorizedAtomic = cumulative;
        await session.save();
        return signPending(session, entry, signer);
      });
    },
    recoverPending(
      _channelId: string,
      _read: ReusableObservationReader,
      _signer: BatchClientSigner,
    ): Promise<SignedReusableVoucher> {
      return recoverPending();
    },
  };
}
