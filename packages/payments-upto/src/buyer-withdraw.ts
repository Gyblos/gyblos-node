// Takes the buyer's stuck channels one withdrawal step further once the seller can no longer claim
// them: the distribution is rebuilt from the buyer's own policy. The journal is left as is;
// reconciliation resolves each channel from finalized history after its escrow is distributed.
import type { UptoWithdrawQuery, UptoWithdrawResult } from 'x402-upto-metered';

import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import type { UptoBuyerJournal } from './buyer-journal';
import { WITHDRAW_STEPS } from './constants';

export type UptoBuyerWithdrawStep =
  (typeof WITHDRAW_STEPS)[keyof typeof WITHDRAW_STEPS];

export interface UptoBuyerWithdrawResult extends Omit<
  UptoWithdrawResult,
  'step'
> {
  requestDigest: string;
  channelId: string;
  step: UptoBuyerWithdrawStep;
}

export interface UptoBuyerWithdrawOptions {
  journal: UptoBuyerJournal;
  withdrawal: {
    withdraw(query: UptoWithdrawQuery): Promise<UptoWithdrawResult>;
  };
  // The buyer's policy: its mint and the network's fee treasury and rate.
  mint: string;
  treasury: string;
  protocolFeeBps: number;
  // How long after the open was signed the seller's claim stays valid (the payload lifetime).
  claimWindowMs: number;
  now: () => number;
  report(result: UptoBuyerWithdrawResult): Promise<void>;
}

const MS_PER_SECOND = 1000;

// Every open, signed entry is visited in journal order; a chain failure rejects, and what was
// already sent stays on chain for the next run to read.
export async function withdrawUptoBuyer(
  options: UptoBuyerWithdrawOptions,
): Promise<UptoBuyerWithdrawResult[]> {
  const results: UptoBuyerWithdrawResult[] = [];
  for (const entry of await options.journal.list()) {
    const { channelId } = entry;
    if (!channelId || entry.state !== PAYMENT_CHANNEL_STATES.OPEN) continue;
    // The entry is written when the open is signed and not again while it stays open.
    const claimableUntil = Math.max(
      entry.expiresAt,
      entry.updatedAt + options.claimWindowMs,
    );
    const left = claimableUntil - options.now();
    const result: UptoBuyerWithdrawResult = {
      requestDigest: entry.requestDigest,
      channelId,
      ...(left >= 0
        ? {
            step: WITHDRAW_STEPS.CLAIMABLE,
            transaction: null,
            confirmed: true,
            retryAfterSeconds: Math.ceil((left + 1) / MS_PER_SECOND),
          }
        : await options.withdrawal.withdraw({
            channelId,
            mint: options.mint,
            rentPayer: entry.feePayer,
            maxAtomic: entry.maxAtomic,
            splits: paymentSplits({
              payTo: entry.payTo,
              treasury: options.treasury,
              protocolFeeBps: options.protocolFeeBps,
            }),
          })),
    };
    await options.report(result);
    results.push(result);
  }
  return results;
}
