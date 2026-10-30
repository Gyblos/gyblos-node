// Paid selling for the daemon: checks the payment server's description against the network's fee and
// the seller's payout, then serves paid offers with a paid ledger, settlement under the daemon's own
// signal and a background retry of pending claims. The payment server is the caller's (built from the
// role's keys and chain); this module never reads keys, files or the chain.
import { DEVNET, PROTOCOL_FEE } from '@gyblos/config';
import { PaidSellerLedger } from '@gyblos/core/paid-admission';
import type {
  PaymentDescription,
  PaymentServer,
} from '@gyblos/protocol/payment';
import type { PaidExecutionService } from '@gyblos/transport-iroh/paid-server';

import { NODE_ERROR_CODES, PAID_SETTLEMENT } from './constants';
import { NodeError } from './errors';
import { createSellerPaidOffers } from './paid-offers';
import { createPaidRetry, type PaidRetryHealth } from './paid-retry';
import type { LiveSellerOffer } from './seller-offer-set';

export interface SellerPayments {
  server: PaymentServer;
  // Releases the payment server's own resources (its ledger lock, connections).
  close(): Promise<void>;
}

export interface SellerPaid {
  description: PaymentDescription;
  service: PaidExecutionService;
  health(): PaidRetryHealth & { failedClaims: number };
  close(): Promise<void>;
}

// Buyers pay the listed price, which already includes PROTOCOL_FEE; the channel must split by it too,
// and the seller's payout must not be the account that pays transaction fees.
function checkedDescription(description: PaymentDescription) {
  if (
    description.network !== DEVNET ||
    description.protocolFeeBps !== PROTOCOL_FEE.bps ||
    description.treasury !== PROTOCOL_FEE.treasury ||
    description.payTo === description.feePayer
  )
    throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_DESCRIPTION_INVALID);
  return description;
}

export async function startSellerPaid(
  payments: SellerPayments,
  options: {
    owner: string;
    nodeId: string;
    startedAt: number;
    now?: () => number;
    offers: () => readonly LiveSellerOffer[];
    settlement?: { waitMs: number; retryDelaysMs: readonly number[] };
  },
): Promise<SellerPaid> {
  const timing = options.settlement ?? PAID_SETTLEMENT;
  const description = checkedDescription(await payments.server.describe());
  const daemon = new AbortController();
  const retry = createPaidRetry({
    payment: payments.server,
    delaysMs: timing.retryDelaysMs,
  });
  let failedClaims = 0;
  const service = createSellerPaidOffers(options.offers, {
    owner: options.owner,
    nodeId: options.nodeId,
    now: options.now ?? Date.now,
    ledger: new PaidSellerLedger(options.startedAt),
    payment: payments.server,
    settlement: {
      signal: daemon.signal,
      waitMs: timing.waitMs,
      onPending: (admission, chargedAtomic) =>
        retry.queue(admission, chargedAtomic),
      onFailure: () => {
        failedClaims++;
      },
    },
  });
  return {
    description,
    service,
    health: () => ({ ...retry.health(), failedClaims }),
    // Stops waiting on claims first, then retries, then the payment server itself.
    async close() {
      daemon.abort();
      await retry.stop();
      await payments.close();
    },
  };
}

// Builds the payment server and starts paid selling; a refused description closes the server again.
export async function openSellerPaid(
  open: () => Promise<SellerPayments>,
  options: Parameters<typeof startSellerPaid>[1],
): Promise<SellerPaid> {
  const payments = await open();
  try {
    return await startSellerPaid(payments, options);
  } catch (error) {
    await payments.close();
    throw error;
  }
}
