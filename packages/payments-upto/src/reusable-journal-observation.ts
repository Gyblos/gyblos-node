// Checks an independently supplied finalized channel observation against frozen opening terms.
// The reader supplying the observation, genesis and latest finalized tip must itself be trusted.
import { uptoDistributionHash } from 'x402-upto-metered';

import { CHANNEL_PROGRAM } from '@gyblos/config';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import { REUSABLE_JOURNAL_STATES } from './constants';
import {
  atomic,
  unavailable,
  type FinalizedOpenObservation,
  type ReusableChannelEntry,
  type ReusableChannelTerms,
} from './reusable-journal-model';

export function findChannel(
  entries: ReusableChannelEntry[],
  channelId: string,
): ReusableChannelEntry {
  return (
    entries.find(
      (item) =>
        item.terms.channelId === channelId &&
        item.status !== REUSABLE_JOURNAL_STATES.NOT_OPENED,
    ) ??
    entries.find((item) => item.terms.channelId === channelId) ??
    unavailable()
  );
}
export function verifyObservation(
  expected: ReusableChannelTerms,
  observed: FinalizedOpenObservation,
  upper: string,
  minimumSlot: string,
): void {
  const distributionHash = Buffer.from(
    uptoDistributionHash(paymentSplits(expected)),
  ).toString('hex');
  if (
    !observed ||
    observed.finalized !== true ||
    atomic(observed.contextSlot) !== atomic(observed.finalizedTipSlot) ||
    BigInt(observed.contextSlot) < BigInt(minimumSlot) ||
    BigInt(observed.contextSlot) < BigInt(expected.openSlot) ||
    observed.state !== 'open' ||
    observed.programOwner !== CHANNEL_PROGRAM ||
    observed.channelId !== expected.channelId ||
    observed.network !== expected.network ||
    observed.payer !== expected.buyer ||
    observed.payee !== expected.feePayer ||
    observed.rentPayer !== expected.feePayer ||
    observed.authorizedSigner !== expected.buyer ||
    observed.mint !== expected.mint ||
    observed.tokenProgram !== expected.tokenProgram ||
    observed.salt !== expected.salt ||
    observed.openSlot !== expected.openSlot ||
    observed.gracePeriod !== expected.gracePeriod ||
    observed.depositAtomic !== expected.depositAtomic ||
    observed.distributionHash !== distributionHash ||
    BigInt(atomic(observed.settledAtomic)) > BigInt(upper) ||
    BigInt(atomic(observed.paidAtomic)) > BigInt(observed.settledAtomic)
  )
    unavailable();
}
