// Pure single use and generation slots for paid requests; the caller supplies time. No I/O, payments
// or engines. A request id is spent before any deposit, so a replay never moves funds twice.
import {
  paidExecutionFail as fail,
  type PaidExecutionRequest,
} from '@gyblos/protocol/paid-execution';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';

import { PAID_EXECUTION_ADMISSION } from './constants';

const instant = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    return fail(PAID_EXECUTION_CODES.INVALID);
  return value;
};

export class PaidSellerLedger {
  private readonly seen = new Map<string, number>();
  private lastNow: number;
  private active = 0;
  constructor(private readonly startedAt: number) {
    this.lastNow = instant(startedAt);
  }
  // Refuses an expired, replayed or over-capacity request; otherwise spends its id and holds a
  // generation slot until the returned release, which is idempotent.
  admit(request: PaidExecutionRequest, now: number): () => void {
    instant(now);
    const quote = request.quote.offer;
    if (
      now < this.lastNow ||
      quote.issuedAt <= this.startedAt ||
      quote.issuedAt > now ||
      quote.expiresAt <= now
    )
      return fail(PAID_EXECUTION_CODES.EXPIRED);
    this.lastNow = now;
    for (const [key, expiry] of this.seen)
      if (expiry <= now) this.seen.delete(key);
    const key = `${quote.buyerNodeId}/${quote.requestId}`;
    if (this.seen.has(key)) return fail(PAID_EXECUTION_CODES.REPLAY);
    if (
      this.active >= PAID_EXECUTION_ADMISSION.maxConcurrent ||
      this.seen.size >= PAID_EXECUTION_ADMISSION.maxReplayEntries
    )
      return fail(PAID_EXECUTION_CODES.BUSY);
    this.seen.set(key, quote.expiresAt);
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}
