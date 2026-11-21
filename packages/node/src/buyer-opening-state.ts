// Resolves the previous OPEN before considering renewal or closing an expired channel.
import {
  OPENING_STATUS,
  SESSION_CODES,
} from '@gyblos/protocol/payment-session';
import type { BatchDestination } from '@gyblos/transport-iroh/batch-client';

import { UnsentOpeningError } from './buyer-opening-retry';
import { bounded } from './buyer-operation';
import type { Current, State } from './buyer-session';

export async function disposeAbsent<Remote extends BatchDestination>(
  state: State<Remote>,
  opened: Current<Remote>,
) {
  try {
    await opened.host.disconnect();
    await opened.host.settled();
    await opened.financial.dispose();
    state.current = undefined;
  } catch {
    // Keep the owner on cleanup failure; the durable absence proof remains authoritative.
    throw new UnsentOpeningError(SESSION_CODES.OPENING_ABSENT);
  }
}
export async function checkPreviousOpening<Remote extends BatchDestination>(
  state: State<Remote>,
  opened: Current<Remote>,
  signal: AbortSignal,
) {
  if (opened.financial.openingRecovery?.pending()) {
    // Check the original deposit even after expiry, before attempting CLOSE on a nonexistent channel.
    const recovery = opened.financial.openingRecovery;
    const status = await bounded(recovery.status(signal), signal).catch(
      () => OPENING_STATUS.UNKNOWN,
    );
    if (status === OPENING_STATUS.ABSENT) {
      await disposeAbsent(state, opened);
      throw new UnsentOpeningError(SESSION_CODES.OPENING_ABSENT);
    }
    if (status !== OPENING_STATUS.PRESENT) {
      const settled = await opened.host
        .reconcile(signal)
        .catch(() => undefined);
      if (
        settled &&
        settled.chargedAtomic === '0' &&
        settled.refundedAtomic === opened.terms.depositAtomic
      ) {
        await disposeAbsent(state, opened);
        throw new UnsentOpeningError(SESSION_CODES.OPENING_RETURNED);
      }
      throw new UnsentOpeningError(SESSION_CODES.OPENING_PENDING);
    }
    return true;
  }
  return false;
}
