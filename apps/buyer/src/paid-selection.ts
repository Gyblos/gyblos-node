// The paid buyer's real dependencies: verified selection quoted at the configured ceilings (paid sellers
// only), execution over the paid stream to a configured seller, one paid request at a time, and the
// payment journal deciding whether an earlier channel still needs reconciliation.
import { PAYMENT_CHANNEL_STATES } from '@gyblos/protocol/constants';
import type { RecountTokenizer } from '@gyblos/protocol/engine';
import { PAID_EXECUTION_CODES } from '@gyblos/protocol/paid/constants';
import type { PaymentClient } from '@gyblos/protocol/payment';
import {
  createPaidExecutionClient,
  PaidClientError,
} from '@gyblos/transport-iroh/paid-client';

import { isFreeAtomic, PAID_BUYER, PAID_BUYER_CODES } from './constants';
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
  isFreeAtomic(winner.quote.offer.maxAtomic);

// A winner quoted at the configured ceilings that this buyer may pay: a configured seller, still
// permitted by discovery and with its identity verified, all before any open is signed. A free quote
// or a seller failing those checks is skipped, so a paid buyer pays every time.
async function selectPaidWinner(
  prepared: PreparedSelection,
  options: PaidSelectionOptions,
  excluded: ReadonlySet<string>,
  signal: AbortSignal,
): Promise<PaidWinner> {
  const now = options.now ?? Date.now;
  const skipped = new Set(excluded);
  for (let attempt = 0; attempt <= PAID_BUYER.freeSkips; attempt++) {
    const winner = await (options.choose ?? selectWinner)(
      prepared,
      options,
      skipped,
      signal,
      prepared.config.request,
    );
    const seller = prepared.config.sellers.find(
      (each) => each.nodeId === winner.nodeId,
    );
    if (
      seller &&
      !isFreeQuote(winner) &&
      (await permitsWinner(prepared, winner, now())) &&
      (await verifyBuyerIdentity(prepared.identity, seller, signal))
    )
      return winner;
    signal.throwIfAborted();
    skipped.add(winner.nodeId);
  }
  throw new PaidBuyerError(PAID_BUYER_CODES.UNAVAILABLE);
}

export function paidBuyerDependencies(
  prepared: PreparedSelection,
  options: PaidSelectionOptions,
): PaidBuyerDependencies & {
  // Resolves once no paid request is running, for an orderly shutdown.
  idle(): Promise<void>;
} {
  requireBuyerIdentity(prepared.config, prepared.identity);
  let active = false;
  let finished = Promise.resolve();
  let finish = () => {};
  const now = options.now ?? Date.now;
  const client = options.client ?? createPaidExecutionClient;
  const sellers = new Map(
    prepared.config.sellers.map((seller) => [seller.nodeId, seller]),
  );
  return {
    enter() {
      if (active) throw new PaidBuyerError(PAID_BUYER_CODES.BUSY);
      active = true;
      finished = new Promise((resolve) => {
        finish = resolve;
      });
      return () => {
        active = false;
        finish();
      };
    },
    idle: () => finished,
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
      // Checked again after signing; a refusal here sends nothing, so the open is discarded.
      if (signal.aborted)
        throw new PaidClientError(PAID_EXECUTION_CODES.CANCELLED, false);
      if (
        !seller ||
        isFreeQuote(winner) ||
        !(await permitsWinner(prepared, winner, now()))
      )
        throw new PaidClientError(PAID_EXECUTION_CODES.PEER, false);
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
