// Feeds the real reconciliation command a synthetic finalized history reconstructed from the fake ledger.
import assert from 'node:assert/strict';

import { main as reconcile } from '@gyblos/buyer/reconcile-paid';
import { DEVNET_GENESIS, DEVNET_USDC, PROTOCOL_FEE } from '@gyblos/config';
import {
  buyerChainReconcile,
  RECONCILE_OUTCOMES,
} from '@gyblos/node/buyer-reconcile';

import type { PaidAcceptanceHost } from './paid-acceptance-host';
import { chainDouble, signatureOf } from './upto-chain-history';

export async function reconcileInterrupted(run: PaidAcceptanceHost) {
  const authorization = run.payments.latestAuthorization();
  const settlement = [...run.payments.ledger.transactions.values()].at(-1);
  assert.ok(authorization && settlement && run.roles.seller.payTo);
  assert.equal(settlement.channelId, authorization.channelId);
  const chain = chainDouble({
    mint: DEVNET_USDC,
    blockHeight: 1000n,
    oldestSlot: 1n,
    accounts: new Set(),
    history: new Map([
      [
        authorization.channelId,
        [
          {
            signature: signatureOf(45),
            flows: [
              { owner: authorization.channelId, before: 10000n, after: 0n },
              {
                owner: run.roles.buyer.buyer,
                before: 0n,
                after: BigInt(settlement.refundedAtomic),
              },
              {
                owner: run.roles.seller.payTo,
                before: 0n,
                after: BigInt(settlement.sellerAtomic),
              },
              {
                owner: PROTOCOL_FEE.treasury,
                before: 0n,
                after: BigInt(settlement.feeAtomic),
              },
            ],
          },
        ],
      ],
    ]),
  });
  const lines: string[] = [];
  const results = await reconcile(
    buyerChainReconcile(async () => DEVNET_GENESIS, chain.rpc),
    (line) => lines.push(line),
  );
  assert.equal(results?.length, 1);
  assert.equal(results[0]?.outcome, RECONCILE_OUTCOMES.SETTLED);
  assert.equal(results[0]?.expectedAtomic, '45');
  assert.equal(results[0]?.chargedAtomic, '45');
  assert.equal(results[0]?.refundedAtomic, '9955');
  assert.ok(lines.length > 0);
}
