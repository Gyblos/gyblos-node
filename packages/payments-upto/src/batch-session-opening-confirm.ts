// The SDK looks for a channel it just funded only a few seconds; a slow RPC can show it later. While a
// deposit of this opening may have been sent (the store still names its channel, or a settlement is still
// running), the seller keeps observing the finalized opening for a bounded time before answering
// unavailable. Observation reads the chain, never the buyer's claim.
import { setTimeout as sleep } from 'node:timers/promises';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import {
  PaymentSessionError,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';

import {
  depositSettlementsRunning,
  type BatchOpening,
} from './batch-session-opening-release';
import type { BatchStore } from './batch-session-store';
import { waitBatch } from './batch-session-wait';

export interface OpeningConfirmation {
  observe: () => Promise<boolean>;
  operationMs?: number;
  confirmMs?: number;
  pollMs?: number;
}

// Any pending key naming the channel: the SDK reserves it before sending and drops it only when the
// deposit failed on chain.
export const depositMayBeSent = (store: BatchStore, opening: BatchOpening) => {
  const channelId = opening.voucher!.channelId;
  return (
    depositSettlementsRunning(store) ||
    Object.keys(store.read().pending).some((key) => key.includes(channelId))
  );
};

// A channel seen in another state, or another opening, is an answer: waiting longer cannot change it.
const settledAnswer = (error: unknown) =>
  error instanceof PaymentSessionError &&
  (error.code === SESSION_CODES.BINDING ||
    error.code === SESSION_CODES.UNVERIFIED);

export async function confirmSentOpening(
  store: BatchStore,
  opening: BatchOpening,
  confirmation: OpeningConfirmation,
) {
  const confirmMs =
    confirmation.confirmMs ?? BATCH_SESSION_DEFAULTS.openingConfirmMs;
  const pollMs =
    confirmation.pollMs ?? BATCH_SESSION_DEFAULTS.openingConfirmPollMs;
  const operationMs =
    confirmation.operationMs ?? BATCH_SESSION_DEFAULTS.operationMs;
  const deadline = performance.now() + confirmMs;
  while (depositMayBeSent(store, opening)) {
    const left = deadline - performance.now();
    if (left <= 0) return false;
    try {
      if (await waitBatch(confirmation.observe(), Math.min(operationMs, left)))
        return true;
    } catch (error) {
      if (settledAnswer(error)) return false;
    }
    if (deadline - performance.now() <= pollMs) return false;
    await sleep(pollMs);
  }
  return false;
}
