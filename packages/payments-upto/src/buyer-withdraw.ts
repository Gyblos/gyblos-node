// Takes the buyer's stuck channels one withdrawal step further once the seller can no longer claim
// them: the distribution is rebuilt from the buyer's own policy. The journal is left as is;
// reconciliation resolves each channel from finalized history after its escrow is distributed.
import {
  UPTO_ERROR_CODES,
  uptoError,
  type UptoErrorCode,
  type UptoWithdrawQuery,
  type UptoWithdrawResult,
} from 'x402-upto-metered';

import {
  PAYMENT_CHANNEL_STATES,
  PAYMENT_ERROR_CODES,
} from '@gyblos/protocol/constants';
import { PaymentError } from '@gyblos/protocol/payment';
import { paymentSplits } from '@gyblos/protocol/payment-binding';

import type { UptoBuyerJournal, UptoJournalEntry } from './buyer-journal';
import {
  BUYER_WITHDRAW,
  WITHDRAW_STEPS,
  type NetworkRecoveryBlock,
} from './constants';
import {
  checkJournalNetwork,
  networkRecoveryBlock,
  snapshotJournal,
  snapshotJournalEntry,
} from './journal-network';
import { assertPaymentNetworkEnabled } from './mainnet';

export type UptoBuyerWithdrawStep =
  (typeof WITHDRAW_STEPS)[keyof typeof WITHDRAW_STEPS];

export interface UptoBuyerWithdrawResult extends Omit<
  UptoWithdrawResult,
  'step'
> {
  requestDigest: string;
  channelId: string;
  step: UptoBuyerWithdrawStep;
  // Why a failed step failed, as a static code; null otherwise.
  failure: UptoErrorCode | null;
  // Present when this signed channel cannot be attributed to the selected network.
  networkBlock?: NetworkRecoveryBlock;
}

export interface UptoBuyerWithdrawOptions {
  journal: UptoBuyerJournal;
  // The network already established by the caller's RPC check.
  network: string;
  withdrawal: {
    withdraw(query: UptoWithdrawQuery): Promise<UptoWithdrawResult>;
  };
  // The buyer's policy: its mint and the network's fee treasury and rate. Each channel is withdrawn
  // with the policy its open accepted; this one only for an entry journaled without it.
  mint: string;
  treasury: string;
  protocolFeeBps: number;
  // The lifetime of the payload the buyer signed with each open, in seconds.
  maxTimeoutSeconds: number;
  now: () => number;
  report(result: UptoBuyerWithdrawResult): Promise<void>;
}

const { msPerSecond } = BUYER_WITHDRAW;

// The network preflight uses payment-port errors; preserve their meaning in withdrawal results.
function withdrawalFailure(error: unknown): UptoErrorCode {
  if (error instanceof PaymentError) {
    if (error.code === PAYMENT_ERROR_CODES.UNAVAILABLE)
      return UPTO_ERROR_CODES.UNAVAILABLE;
    if (error.code === PAYMENT_ERROR_CODES.UNTRUSTED_TERMS)
      return UPTO_ERROR_CODES.INVALID_TERMS;
  }
  return uptoError(error).code;
}

// Until when the seller may still claim: the quote's expiry or the signed payload's lifetime, plus the
// margin. The entry is written when the open is signed and not again while it stays open.
const claimableUntil = (
  entry: UptoJournalEntry,
  options: UptoBuyerWithdrawOptions,
) =>
  Math.max(
    entry.expiresAt,
    entry.updatedAt + options.maxTimeoutSeconds * msPerSecond,
  ) + BUYER_WITHDRAW.claimMarginMs;

async function stepFor(
  entry: UptoJournalEntry & { channelId: string },
  options: UptoBuyerWithdrawOptions,
): Promise<Omit<UptoBuyerWithdrawResult, 'requestDigest' | 'channelId'>> {
  const left = claimableUntil(entry, options) - options.now();
  if (left >= 0)
    return {
      step: WITHDRAW_STEPS.CLAIMABLE,
      transaction: null,
      confirmed: true,
      retryAfterSeconds: Math.ceil((left + 1) / msPerSecond),
      failure: null,
    };
  const { mint, treasury, protocolFeeBps } = entry.policy ?? options;
  try {
    const done = await options.withdrawal.withdraw({
      channelId: entry.channelId,
      mint,
      rentPayer: entry.feePayer,
      maxAtomic: entry.maxAtomic,
      splits: paymentSplits({ payTo: entry.payTo, treasury, protocolFeeBps }),
    });
    return { ...done, failure: null };
  } catch (error) {
    return {
      step: WITHDRAW_STEPS.FAILED,
      transaction: null,
      confirmed: true,
      retryAfterSeconds: BUYER_WITHDRAW.failedRetrySeconds,
      failure: withdrawalFailure(error),
    };
  }
}

// Every open, signed entry is visited in journal order; one channel's chain failure is reported and
// the run goes on. Only a report failure rejects, and what was sent stays on chain for the next run.
export async function withdrawUptoBuyer(
  options: UptoBuyerWithdrawOptions,
): Promise<UptoBuyerWithdrawResult[]> {
  const network = options.network;
  assertPaymentNetworkEnabled(network);
  const withdraw = options.withdrawal.withdraw.bind(options.withdrawal);
  const fixed: UptoBuyerWithdrawOptions = {
    network,
    journal: snapshotJournal(options.journal),
    withdrawal: { withdraw },
    mint: options.mint,
    treasury: options.treasury,
    protocolFeeBps: options.protocolFeeBps,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
    now: options.now.bind(options),
    report: options.report.bind(options),
  };
  checkJournalNetwork(fixed.network);
  const entries = (await fixed.journal.list()).map(snapshotJournalEntry);
  const results: UptoBuyerWithdrawResult[] = [];
  for (const entry of entries) {
    const { channelId } = entry;
    if (!channelId || entry.state !== PAYMENT_CHANNEL_STATES.OPEN) continue;
    const networkBlock = networkRecoveryBlock(entry, fixed.network);
    const result: UptoBuyerWithdrawResult = networkBlock
      ? {
          requestDigest: entry.requestDigest,
          channelId,
          step: WITHDRAW_STEPS.REFUSED,
          transaction: null,
          confirmed: true,
          retryAfterSeconds: null,
          failure: null,
          networkBlock,
        }
      : {
          requestDigest: entry.requestDigest,
          channelId,
          ...(await stepFor({ ...entry, channelId }, fixed)),
        };
    await fixed.report(result);
    results.push(result);
  }
  return results;
}
