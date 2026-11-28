// Recovery is confined to OPEN. The caller closes over one payload, before any prompt is sent.
import { setTimeout as delay } from 'node:timers/promises';

import { BATCH_SESSION_DEFAULTS } from '@gyblos/config/batch-session';
import { BatchChannelError } from '@gyblos/protocol/batch-channel';
import {
  OPENING_STATUS,
  SESSION_CODES,
  type SessionBuyer,
} from '@gyblos/protocol/payment-session';

import { bounded } from './buyer-operation';

export class UnsentSessionPreflightError extends BatchChannelError {}

export class UnsentOpeningError extends BatchChannelError {
  constructor(
    code:
      | typeof SESSION_CODES.OPENING_ABSENT
      | typeof SESSION_CODES.OPENING_PENDING
      | typeof SESSION_CODES.OPENING_RETURNED,
  ) {
    super(code);
  }
}
export async function recoverBuyerOpening<T>(
  buyer: SessionBuyer,
  prepare: () => Promise<() => Promise<T>>,
  verify: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  permit: <R>(work: () => Promise<R>) => Promise<R> = (work) => work(),
): Promise<T> {
  const evidence = buyer.openingRecovery;
  const first = await permit(async () => {
    const awaitingFirstCharge = buyer.snapshot().cumulativeAtomic === '0';
    const open = await prepare();
    if (!evidence) return { value: await open() };
    if (await evidence.claim()) {
      try {
        return { value: await open(), confirm: awaitingFirstCharge };
      } catch {
        signal.throwIfAborted();
      }
    }
    return { replay: open, evidence };
  });
  if (!first.replay) {
    if (first.confirm && evidence) {
      const confirmation = AbortSignal.any([
        signal,
        AbortSignal.timeout(BATCH_SESSION_DEFAULTS.openingConfirmMs),
      ]);
      while (!confirmation.aborted) {
        const status = await bounded(
          evidence.status(confirmation),
          confirmation,
        ).catch(() => OPENING_STATUS.UNKNOWN);
        if (status === OPENING_STATUS.PRESENT) return first.value;
        if (status === OPENING_STATUS.ABSENT)
          throw new UnsentOpeningError(SESSION_CODES.OPENING_ABSENT);
        await delay(BATCH_SESSION_DEFAULTS.openingConfirmPollMs, undefined, {
          signal: confirmation,
        }).catch(() => undefined);
      }
      throw new UnsentOpeningError(SESSION_CODES.OPENING_PENDING);
    }
    return first.value;
  }
  const recovery = AbortSignal.any([
    signal,
    AbortSignal.timeout(BATCH_SESSION_DEFAULTS.operationMs),
  ]);
  try {
    // Observe only the original transaction. A missing RPC response proves neither outcome.
    for (const wait of BATCH_SESSION_DEFAULTS.openingRecheckMs) {
      if (wait) await delay(wait, undefined, { signal: recovery });
      const status = await bounded(
        first.evidence.status(recovery),
        recovery,
      ).catch(() => OPENING_STATUS.UNKNOWN);
      recovery.throwIfAborted();
      if (status === OPENING_STATUS.ABSENT)
        throw new UnsentOpeningError(SESSION_CODES.OPENING_ABSENT);
      if (status === OPENING_STATUS.PRESENT) {
        await bounded(verify(recovery), recovery);
        return await permit(first.replay);
      }
    }
  } catch (error) {
    if (error instanceof UnsentOpeningError) throw error;
  }
  throw new UnsentOpeningError(SESSION_CODES.OPENING_PENDING);
}
