// Pure single-use admission and daily token reservations; caller supplies time, no I/O or payments.
import { FREE_EXECUTION_CODES } from '@gyblos/protocol/constants';
import {
  freeExecutionFail as fail,
  type FreeExecutionRequest,
} from '@gyblos/protocol/free-execution';

import { FREE_EXECUTION_ADMISSION } from './constants';

interface DayBudget {
  total: number;
  buyers: Map<string, number>;
}
export interface FreeTokenCaps {
  dailyTokenCap: number;
  perBuyerCap: number;
}
const count = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    return fail(FREE_EXECUTION_CODES.LIMIT);
  return value;
};
export class FreeExecutionAdmission {
  private readonly seen = new Map<string, number>();
  private budget: DayBudget = { total: 0, buyers: new Map() };
  private day = -1;
  private lastNow: number;
  private active = 0;
  private readonly caps: FreeTokenCaps;
  constructor(
    caps: FreeTokenCaps,
    private readonly startedAt: number,
    // Distinct buyers served per UTC day; a seller's gyblos.toml [limits] may set it.
    private readonly maxBuyers: number = FREE_EXECUTION_ADMISSION.maxBuyers,
  ) {
    count(startedAt);
    if (!count(maxBuyers)) fail(FREE_EXECUTION_CODES.LIMIT);
    if (!count(caps.dailyTokenCap) || !count(caps.perBuyerCap))
      fail(FREE_EXECUTION_CODES.LIMIT);
    this.caps = {
      dailyTokenCap: caps.dailyTokenCap,
      perBuyerCap: caps.perBuyerCap,
    };
    this.lastNow = startedAt;
  }
  enter(request: FreeExecutionRequest, inputTokens: number, now: number) {
    count(now);
    const quote = request.quote.offer;
    if (
      now < this.lastNow ||
      quote.issuedAt <= this.startedAt ||
      quote.issuedAt > now ||
      quote.expiresAt <= now
    )
      return fail(FREE_EXECUTION_CODES.EXPIRED);
    this.lastNow = now;
    for (const [key, expiry] of this.seen)
      if (expiry <= now) this.seen.delete(key);
    const key = `${quote.buyerNodeId}/${quote.requestId}`;
    if (this.seen.has(key)) return fail(FREE_EXECUTION_CODES.REPLAY);
    if (
      this.active >= FREE_EXECUTION_ADMISSION.maxConcurrent ||
      this.seen.size >= FREE_EXECUTION_ADMISSION.maxReplayEntries
    )
      return fail(FREE_EXECUTION_CODES.BUSY);
    const day = Math.floor(now / FREE_EXECUTION_ADMISSION.utcDayMs);
    if (day !== this.day) {
      this.day = day;
      this.budget = { total: 0, buyers: new Map() };
    }
    const budget = this.budget;
    const peer = quote.buyerNodeId;
    if (!budget.buyers.has(peer) && budget.buyers.size >= this.maxBuyers)
      return fail(FREE_EXECUTION_CODES.BUSY);
    this.seen.set(key, quote.expiresAt);
    const reserved = count(count(inputTokens) + count(request.input.maxTokens));
    if (reserved > this.caps.dailyTokenCap - budget.total)
      return fail(FREE_EXECUTION_CODES.DAILY_CAP);
    const prior = budget.buyers.get(peer) ?? 0;
    if (reserved > this.caps.perBuyerCap - prior)
      return fail(FREE_EXECUTION_CODES.BUYER_CAP);
    budget.total += reserved;
    budget.buyers.set(peer, prior + reserved);
    this.active++;
    let finished = false;
    return {
      complete: (actual?: number) => {
        if (finished) return;
        finished = true;
        this.active--;
        if (
          actual === undefined ||
          !Number.isSafeInteger(actual) ||
          actual < 0 ||
          actual > reserved
        )
          return;
        const refund = reserved - actual;
        budget.total -= refund;
        budget.buyers.set(peer, budget.buyers.get(peer)! - refund);
      },
    };
  }
}
