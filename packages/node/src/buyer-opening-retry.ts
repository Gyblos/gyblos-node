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

export class UnsentOpeningError extends BatchChannelError {
  constructor(
    code:
      | typeof SESSION_CODES.OPENING_ABSENT
      | typeof SESSION_CODES.OPENING_PENDING,
  ) {
    super(code);
  }
}
export async function recoverBuyerOpening<T>(
  buyer: SessionBuyer,
  open: () => Promise<T>,
  verify: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<T> {
  const evidence = buyer.openingRecovery;
  if (!evidence) return open();
  const attempt = async () => {
    const result = await open();
    await evidence.acknowledged();
    return result;
  };
  if (await evidence.claim()) {
    try {
      return await attempt();
    } catch {
      signal.throwIfAborted();
    }
  }
  const recovery = AbortSignal.any([
    signal,
    AbortSignal.timeout(BATCH_SESSION_DEFAULTS.operationMs),
  ]);
  try {
    // Observe only the original transaction. A missing RPC response proves neither outcome.
    for (const wait of BATCH_SESSION_DEFAULTS.openingRecheckMs) {
      if (wait) await delay(wait, undefined, { signal: recovery });
      const status = await bounded(evidence.status(recovery), recovery).catch(
        () => OPENING_STATUS.UNKNOWN,
      );
      recovery.throwIfAborted();
      if (status === OPENING_STATUS.ABSENT)
        throw new UnsentOpeningError(SESSION_CODES.OPENING_ABSENT);
      if (status === OPENING_STATUS.PRESENT) {
        await bounded(verify(recovery), recovery);
        return await attempt();
      }
    }
  } catch (error) {
    if (error instanceof UnsentOpeningError) throw error;
  }
  throw new UnsentOpeningError(SESSION_CODES.OPENING_PENDING);
}
