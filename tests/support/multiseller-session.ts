// Two synthetic sellers share one buyer and asset; each backend owns its own journal and observation.
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { PROTOCOL_FEE } from '@gyblos/config';
import { batchPoolPathsIn } from '@gyblos/config/home';
import {
  createBatchBuyer,
  inspectBatchPool,
  inspectBatchSession,
  openBatchBuyerPool,
} from '@gyblos/payments-upto/batch-session';

import { batchOfferFixture } from './batch-iroh-offer';
import { sessionRig } from './batch-session';

export async function multisellerSession(
  nodes = {
    buyerNodeId: '12'.repeat(32),
    sellers: ['34'.repeat(32), '56'.repeat(32)],
  },
) {
  const a = await sessionRig({
    buyerNodeId: nodes.buyerNodeId,
    sellerNodeId: nodes.sellers[0]!,
    transaction: 'syntheticConfirmedClose',
    treasury: PROTOCOL_FEE.treasury,
  });
  const b = await sessionRig({
    buyerNodeId: a.terms.buyerNodeId,
    sellerNodeId: nodes.sellers[1]!,
    transaction: 'syntheticConfirmedClose',
    treasury: PROTOCOL_FEE.treasury,
    payer: a.buyerOptions.payer,
    mint: a.terms.mint,
  });
  const rigs = [a, b];
  const offers = await Promise.all(
    rigs.map((rig) => batchOfferFixture(rig.terms, rig.owner, rig.now)),
  );
  const paths = batchPoolPathsIn({ GYBLOS_HOME: join(a.root, 'multi') });
  let prepared = 0;
  const pool = () =>
    openBatchBuyerPool({
      paths,
      totalDepositAtomic: '2000',
      now: a.now,
      backend: async (child) => {
        let sellerId = '';
        return {
          inspect: () => inspectBatchSession(child),
          create: async (terms) => {
            prepared++;
            sellerId = terms.sellerNodeId;
            const pending = (await inspectBatchPool(paths)).find(
              (entry) => entry.terms.sellerNodeId === sellerId,
            );
            if (pending?.stored?.snapshot.channelId === '')
              assert.equal(
                pending?.uncertain,
                true,
                'durable intent precedes financial construction',
              );
            return createBatchBuyer({ ...a.buyerOptions, terms, paths: child });
          },
          observe: (id) =>
            (sellerId === a.terms.sellerNodeId ? a : b).sellerOptions.observe(
              id,
            ),
        };
      },
    });
  return {
    a,
    b,
    rigs,
    offers,
    paths,
    prepared: () => prepared,
    options: {
      policy: {
        depositAtomic: '1000',
        totalDepositAtomic: '2000',
        lifetimeMs: 3600000,
        withdrawDelaySeconds: 900,
      },
      inspect: () => inspectBatchPool(paths),
      pool,
      now: a.now,
      meter: offers[0]!.meter,
      unresolved: async () => false,
      verify: async () => {},
    },
    async close() {
      for (const rig of rigs) await rig.dispose();
    },
  };
}
