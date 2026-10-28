// Pure single-use admission and daily token reservations; caller supplies time, no I/O or payments.
// One FreeSellerLedger per seller owns single use, concurrency and distinct buyers per UTC day across all
// its free offers; each offer's FreeExecutionAdmission owns only that offer's token caps.
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
const utcDay = (now: number) =>
  Math.floor(now / FREE_EXECUTION_ADMISSION.utcDayMs);

// A request that passed the seller-wide checks; spending and starting it must follow in this order.
export interface FreeLedgerTicket {
  // Uses the request id until its quote expires, whatever the offer's caps then decide.
  spend(): void;
  // Once only: counts the buyer for the day and holds the seller's generation slot until released.
  start(): () => void;
}

export class FreeSellerLedger {
  private readonly seen = new Map<string, number>();
  private lastNow: number;
  private active = 0;
  private day = -1;
  private buyers = new Set<string>();
  constructor(
    private readonly startedAt: number,
    // Distinct buyers served per UTC day; a seller's gyblos.toml [limits] may set it.
    private readonly maxBuyers: number = FREE_EXECUTION_ADMISSION.maxBuyers,
  ) {
    count(startedAt);
    if (!count(maxBuyers)) fail(FREE_EXECUTION_CODES.LIMIT);
    this.lastNow = startedAt;
  }
  // Refuses an expired, replayed or over-capacity request, or a new buyer beyond the day's limit.
  admit(request: FreeExecutionRequest, now: number): FreeLedgerTicket {
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
    if (utcDay(now) !== this.day) {
      this.day = utcDay(now);
      this.buyers = new Set();
    }
    const peer = quote.buyerNodeId;
    if (!this.buyers.has(peer) && this.buyers.size >= this.maxBuyers)
      return fail(FREE_EXECUTION_CODES.BUSY);
    const buyers = this.buyers;
    let started = false;
    return {
      spend: () => {
        this.seen.set(key, quote.expiresAt);
      },
      start: () => {
        // Admission is checked and spent synchronously; this guards a ticket used twice or held over.
        if (started || this.active >= FREE_EXECUTION_ADMISSION.maxConcurrent)
          return fail(FREE_EXECUTION_CODES.BUSY);
        started = true;
        buyers.add(peer);
        this.active++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.active--;
        };
      },
    };
  }
}

// One free offer: its own day's token budget and per-buyer shares over the seller's ledger.
export class FreeExecutionAdmission {
  private budget: DayBudget = { total: 0, buyers: new Map() };
  private day = -1;
  private readonly caps: FreeTokenCaps;
  constructor(
    caps: FreeTokenCaps,
    private readonly ledger: FreeSellerLedger,
  ) {
    if (!count(caps.dailyTokenCap) || !count(caps.perBuyerCap))
      fail(FREE_EXECUTION_CODES.LIMIT);
    this.caps = {
      dailyTokenCap: caps.dailyTokenCap,
      perBuyerCap: caps.perBuyerCap,
    };
  }
  // A seller with this one offer: its own ledger started at startedAt.
  static standalone(
    caps: FreeTokenCaps,
    startedAt: number,
    maxBuyers?: number,
  ) {
    return new FreeExecutionAdmission(
      caps,
      new FreeSellerLedger(startedAt, maxBuyers),
    );
  }
  enter(request: FreeExecutionRequest, inputTokens: number, now: number) {
    const ticket = this.ledger.admit(request, now);
    if (utcDay(now) !== this.day) {
      this.day = utcDay(now);
      this.budget = { total: 0, buyers: new Map() };
    }
    ticket.spend();
    const reserved = count(count(inputTokens) + count(request.input.maxTokens));
    const budget = this.budget;
    const peer = request.quote.offer.buyerNodeId;
    if (reserved > this.caps.dailyTokenCap - budget.total)
      return fail(FREE_EXECUTION_CODES.DAILY_CAP);
    const prior = budget.buyers.get(peer) ?? 0;
    if (reserved > this.caps.perBuyerCap - prior)
      return fail(FREE_EXECUTION_CODES.BUYER_CAP);
    budget.total += reserved;
    budget.buyers.set(peer, prior + reserved);
    const release = ticket.start();
    let finished = false;
    return {
      // Releases the slot once; refunds unused tokens only for a plausible recounted total.
      complete: (actual?: number) => {
        if (finished) return;
        finished = true;
        release();
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
