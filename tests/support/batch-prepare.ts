// Provisioned synthetic session over local streams, with observable pre-signing operations.
import { createBuyerBatchSession } from '@gyblos/node/batch-buyer';
import { createSellerBatchSession } from '@gyblos/node/batch-seller';
import type { BatchChannelResult } from '@gyblos/protocol/batch-channel';
import type { BatchChannelService } from '@gyblos/transport-iroh/batch-server';

import { batchOfferFixture } from './batch-iroh-offer';
import { batchLoopback } from './batch-loopback';
import { sessionRig } from './batch-session';

export async function batchPrepareFixture(
  openingStatus?: (
    signal: AbortSignal,
  ) => Promise<'present' | 'absent' | 'unknown'>,
  financialPermission?: <T>(run: () => Promise<T>) => Promise<T>,
) {
  const rig = await sessionRig();
  const offers = await batchOfferFixture(rig.terms, rig.owner, rig.now);
  const session = rig.seller();
  const service = createSellerBatchSession({
    session,
    terms: rig.terms,
    offers: () => [offers.live],
    now: rig.now,
  });
  let intercept: BatchChannelService['exchange'] | undefined;
  let replied:
    ((result: BatchChannelResult) => Promise<BatchChannelResult>) | undefined;
  const wire = await batchLoopback(
    {
      async exchange(...args) {
        if (intercept) return intercept(...args);
        const result = await service.exchange(...args);
        return replied ? replied(result) : result;
      },
    },
    rig.terms,
  );
  let verified = 0;
  let verification: (() => Promise<void>) | undefined;
  let pending = false;
  const buyer = createBuyerBatchSession({
    ...wire,
    financialPermission,
    terms: rig.terms,
    buyer: {
      ...rig.buyer,
      ...(openingStatus && {
        openingRecovery: {
          pending: () => pending,
          claim: async () => {
            const first = !pending;
            pending = true;
            return first;
          },
          status: openingStatus,
        },
      }),
    },
    meter: offers.meter,
    now: rig.now,
    unresolved: async () => false,
    verify: async () => {
      verified++;
      await verification?.();
    },
    observe: rig.sellerOptions.observe,
  });
  return {
    rig,
    offers,
    session,
    service,
    buyer,
    verified: () => verified,
    pendingOpening: () => pending,
    verification: (next: typeof verification) => {
      verification = next;
    },
    intercept: (next: typeof intercept) => {
      intercept = next;
    },
    replied: (next: typeof replied) => {
      replied = next;
    },
    async close() {
      await buyer.disconnect();
      await buyer.settled();
      await wire.close();
      await rig.dispose();
    },
  };
}
