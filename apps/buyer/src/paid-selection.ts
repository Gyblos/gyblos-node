// The paid buyer's real dependencies: verified selection quoted at the configured ceilings (paid sellers
// only), execution over the paid stream to a configured seller, one paid request at a time, and the
// payment journal deciding whether an earlier channel still needs reconciliation.
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import type { PaymentClient } from '@gyblos/protocol/payment';
import { createPaidExecutionClient } from '@gyblos/transport-iroh/paid-client';

import { FREE_BUYER_CODES, PAID_BUYER, PAID_BUYER_CODES } from './constants';
import { FreeBuyerError } from './free-chat';
import {
  permitsWinner,
  relayAllowed,
  selectWinner,
  sellerAddress,
  type FreeSelectionOptions,
  type PreparedSelection,
} from './free-selection';
import { requireBuyerIdentity, verifyBuyerIdentity } from './identity';
import { PaidBuyerError } from './paid-errors';
import type {
  PaidBuyerDependencies,
  PaidBuyerRecord,
  PaidWinner,
} from './paid-execution';

export interface PaidSelectionOptions extends FreeSelectionOptions {
  payment: PaymentClient;
  fee: PaidBuyerDependencies['fee'];
  meter: RecountTokenizer;
  record(record: PaidBuyerRecord): Promise<void>;
  // Tests inject these; the defaults select over control and speak the paid stream.
  client?: typeof createPaidExecutionClient;
  choose?: typeof selectWinner;
}

const isFreeQuote = (winner: PaidWinner) =>
  winner.quote.offer.maxAtomic === '0';

// A winner quoted at the configured ceilings; a free quote is skipped, so a paid buyer pays every time.
async function selectPaidWinner(
  prepared: PreparedSelection,
  options: PaidSelectionOptions,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<PaidWinner> {
  const skipped = new Set(excluded);
  for (let attempt = 0; attempt <= PAID_BUYER.freeSkips; attempt++) {
    const winner = await (options.choose ?? selectWinner)(
      prepared,
      options,
      skipped,
      signal,
      prepared.config.request,
    );
    if (!isFreeQuote(winner)) return winner;
    skipped.add(winner.nodeId);
  }
  throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
}

export function paidBuyerDependencies(
  prepared: PreparedSelection,
  options: PaidSelectionOptions,
): PaidBuyerDependencies {
  requireBuyerIdentity(prepared.config, prepared.identity);
  let active = false;
  const now = options.now ?? Date.now;
  const client = options.client ?? createPaidExecutionClient;
  const sellers = new Map(
    prepared.config.sellers.map((seller) => [seller.nodeId, seller]),
  );
  return {
    enter() {
      if (active) throw new PaidBuyerError(PAID_BUYER_CODES.BUSY);
      active = true;
      return () => {
        active = false;
      };
    },
    // Any signed open not yet settled on the buyer's own count waits for reconciliation.
    async unresolved() {
      const channels = await options.payment.reconcile();
      return channels.some(
        (channel) => channel.state !== PAYMENT_CHANNEL_STATES.SETTLED,
      );
    },
    select: (excluded, signal) =>
      selectPaidWinner(prepared, options, excluded, signal),
    payment: options.payment,
    fee: options.fee,
    meter: options.meter,
    async execute(winner, request, signal, onDelta) {
      const seller = sellers.get(winner.nodeId);
      if (
        !seller ||
        isFreeQuote(winner) ||
        !(await permitsWinner(prepared, winner, now())) ||
        !(await verifyBuyerIdentity(prepared.identity, seller, signal))
      )
        throw new FreeBuyerError(FREE_BUYER_CODES.UNAVAILABLE);
      signal.throwIfAborted();
      const paid = client(
        options.endpoint,
        sellerAddress(seller, options.relayOnly),
        seller,
        { now, relayOnly: options.relayOnly, relayAllowed, onDelta },
      );
      try {
        return await paid.execute(request, signal);
      } finally {
        await paid.settled();
      }
    },
    record: options.record,
  };
}
