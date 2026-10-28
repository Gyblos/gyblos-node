// Pure single-use admission and daily token reservations; caller supplies time, no I/O or payments.
// A seller holds one replay ledger (single use and concurrency across all its free offers) and one token
// budget per offer (daily and per-buyer caps, distinct buyers).
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

// Seller-wide: quotes issued after startup, single use per buyer request id, bounded concurrency.
export class FreeReplayLedger {
  private readonly seen = new Map<string, number>();
  private lastNow: number;
  private active = 0;
  constructor(private readonly startedAt: number) {
    count(startedAt);
    this.lastNow = startedAt;
  }
  // Refuses an expired, replayed or over-capacity request; records nothing.
  check(request: FreeExecutionRequest, now: number) {
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
    return key;
  }
  // Spends the request id until its quote expires, whatever the budget then decides.
  record(key: string, expiresAt: number) {
    this.seen.set(key, expiresAt);
  }
  acquire() {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}

// Per offer: the day's token budget, per-buyer shares and the distinct buyers it serves.
class FreeOfferBudget {
  private budget: DayBudget = { total: 0, buyers: new Map() };
  private day = -1;
  private readonly caps: FreeTokenCaps;
  constructor(
    caps: FreeTokenCaps,
    private readonly maxBuyers: number,
  ) {
    if (!count(maxBuyers)) fail(FREE_EXECUTION_CODES.LIMIT);
    if (!count(caps.dailyTokenCap) || !count(caps.perBuyerCap))
      fail(FREE_EXECUTION_CODES.LIMIT);
    this.caps = {
      dailyTokenCap: caps.dailyTokenCap,
      perBuyerCap: caps.perBuyerCap,
    };
  }
  // Rolls the UTC day and refuses a new buyer beyond the day's distinct-buyer limit.
  admitBuyer(peer: string, now: number) {
    const day = Math.floor(now / FREE_EXECUTION_ADMISSION.utcDayMs);
    if (day !== this.day) {
      this.day = day;
      this.budget = { total: 0, buyers: new Map() };
    }
    if (
      !this.budget.buyers.has(peer) &&
      this.budget.buyers.size >= this.maxBuyers
    )
      return fail(FREE_EXECUTION_CODES.BUSY);
  }
  // Reserves the full request; refund returns what the engine did not use, once and only if plausible.
  reserve(peer: string, reserved: number) {
    const budget = this.budget;
    if (reserved > this.caps.dailyTokenCap - budget.total)
      return fail(FREE_EXECUTION_CODES.DAILY_CAP);
    const prior = budget.buyers.get(peer) ?? 0;
    if (reserved > this.caps.perBuyerCap - prior)
      return fail(FREE_EXECUTION_CODES.BUYER_CAP);
    budget.total += reserved;
    budget.buyers.set(peer, prior + reserved);
    return (actual?: number) => {
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
    };
  }
}

// One free offer's admission: its own budget over the seller's ledger (a private one when not shared).
export class FreeExecutionAdmission {
  private readonly ledger: FreeReplayLedger;
  private readonly budget: FreeOfferBudget;
  constructor(
    caps: FreeTokenCaps,
    startedAt: number,
    // Distinct buyers served per UTC day; a seller's gyblos.toml [limits] may set it.
    maxBuyers: number = FREE_EXECUTION_ADMISSION.maxBuyers,
    ledger?: FreeReplayLedger,
  ) {
    this.ledger = ledger ?? new FreeReplayLedger(startedAt);
    count(startedAt);
    this.budget = new FreeOfferBudget(caps, maxBuyers);
  }
  enter(request: FreeExecutionRequest, inputTokens: number, now: number) {
    const key = this.ledger.check(request, now);
    const peer = request.quote.offer.buyerNodeId;
    this.budget.admitBuyer(peer, now);
    this.ledger.record(key, request.quote.offer.expiresAt);
    const reserved = count(count(inputTokens) + count(request.input.maxTokens));
    const refund = this.budget.reserve(peer, reserved);
    const release = this.ledger.acquire();
    let finished = false;
    return {
      complete: (actual?: number) => {
        if (finished) return;
        finished = true;
        release();
        refund(actual);
      },
    };
  }
}
