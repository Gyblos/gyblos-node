// Paid selling for the daemon: checks the caller's payment server against the network fee, the role and
// the payout, then serves paid offers with a paid ledger, settlement under the daemon's own signal and
// background recovery and retry of claims. It never reads keys, files or the chain itself.
import { DEVNET, PROTOCOL_FEE } from '@gyblos/config';
import { PaidSellerLedger } from '@gyblos/core/paid-admission';
import type {
  PaymentDescription,
  PaymentServer,
} from '@gyblos/protocol/payment';
import type { PaidExecutionService } from '@gyblos/transport-iroh/paid-server';

import { NODE_ERROR_CODES, PAID_SETTLEMENT } from './constants';
import { NodeError } from './errors';
import {
  createSellerPaidOffers,
  type SellerPaidOffersOptions,
} from './paid-offers';
import { createPaidRetry, type PaidRetryHealth } from './paid-retry';
import type { LiveSellerOffer } from './seller-offer-set';
import type { SellerSessionBackend } from './session-backend';

export interface SellerPayments {
  sessions?: { buyerNodeId: string; backend: SellerSessionBackend };
  server: PaymentServer;
  // Re-drives claims the payment server recorded before a restart, each with its recorded charge.
  recover?(): Promise<void>;
  // Releases the payment server's own resources (its ledger lock, connections).
  close(): Promise<void>;
}

export interface SellerPaidHealth extends PaidRetryHealth {
  // Claims the payment server refused on the request path for a reason retrying cannot fix.
  refusedClaims: number;
  // Whether recovery as a whole failed; the payment server may still skip single claims it cannot
  // reach, which then wait for the next start.
  recoveryFailed: boolean;
}

export interface SellerPaid {
  sessions?: SellerPayments['sessions'];
  description: PaymentDescription;
  service: PaidExecutionService;
  health(): SellerPaidHealth;
  close(): Promise<void>;
}

// Buyers pay the listed price, which already includes PROTOCOL_FEE, so the channel must split by it
// too; the asset is the role's, and the payout differs from keys that sign channel steps.
// The payout may be the offer owner.
function checkedDescription(
  description: PaymentDescription,
  role: { mint: string },
) {
  if (
    description.network !== DEVNET ||
    description.mint !== role.mint ||
    description.protocolFeeBps !== PROTOCOL_FEE.bps ||
    description.treasury !== PROTOCOL_FEE.treasury ||
    [description.feePayer, description.authorizer].includes(description.payTo)
  )
    throw new NodeError(NODE_ERROR_CODES.SELLER_PAYMENT_DESCRIPTION_INVALID);
  return description;
}

export async function startSellerPaid(
  payments: SellerPayments,
  options: {
    owner: string;
    // The role's asset; the payment server must be paid in it.
    mint: string;
    nodeId: string;
    startedAt: number;
    now?: () => number;
    offers: () => readonly LiveSellerOffer[];
    telemetry?: SellerPaidOffersOptions['telemetry'];
    settlement?: { waitMs: number; retryDelaysMs: readonly number[] };
  },
): Promise<SellerPaid> {
  const timing = options.settlement ?? PAID_SETTLEMENT;
  const description = checkedDescription(await payments.server.describe(), {
    mint: options.mint,
  });
  const daemon = new AbortController();
  const retry = createPaidRetry({
    payment: payments.server,
    delaysMs: timing.retryDelaysMs,
    attemptMs: timing.waitMs,
  });
  let refusedClaims = 0;
  let recoveryFailed = false;
  // Claims left by an earlier run are settled in the background; serving does not wait for them.
  const recovering = (payments.recover?.() ?? Promise.resolve()).catch(() => {
    recoveryFailed = true;
  });
  const service = createSellerPaidOffers(options.offers, {
    owner: options.owner,
    telemetry: options.telemetry,
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
        refusedClaims++;
      },
    },
  });
  return {
    description,
    sessions: payments.sessions,
    service,
    health: () => ({ ...retry.health(), refusedClaims, recoveryFailed }),
    // Stops waiting on claims first, then retries, then gives recovery up to one claim wait (a hung
    // claim must not block shutdown), then closes the payment server, which refuses later writes.
    async close() {
      daemon.abort();
      await retry.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        recovering,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timing.waitMs);
        }),
      ]);
      clearTimeout(timer);
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
