import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startFreeBuyerHttp } from '@gyblos/buyer/free-http';
import { checkDesktopPool } from '@gyblos/buyer/session-requirements';
import { batchPoolPathsIn } from '@gyblos/config/home';
import { DEVNET, DEVNET_USDC } from '@gyblos/config/network';
import { X402Budget } from '@gyblos/desktop/x402-budget';
import { X402Client } from '@gyblos/desktop/x402-client';
import { createBuyerSessionPool } from '@gyblos/node/buyer-session-pool';
import {
  openBatchBuyerPool,
  poolAllowsSellerDeposit,
} from '@gyblos/payments-upto/batch-session';
import { MODEL_IDS } from '@gyblos/protocol/constants';

import { sessionRig } from './support/batch-session';
import { multisellerLoopback } from './support/multiseller-session';

void test('review reconciles a settled interrupted pool row before selecting the next paid seller', async (t) => {
  const rig = await sessionRig({ depositAtomic: '10000' });
  t.after(rig.dispose);
  await rig.open();
  await rig.serve(1, '40');
  const paths = batchPoolPathsIn({ GYBLOS_HOME: rig.root });
  const total = '20000';
  const pool = await openBatchBuyerPool({
    paths,
    totalDepositAtomic: total,
    now: rig.now,
    backend: async () => assert.fail('unexpected deposit'),
  });
  t.after(pool.dispose);
  const id = rig.terms.sellerNodeId;
  const next = () =>
    poolAllowsSellerDeposit(paths, '56'.repeat(32), total, '10000');
  const interrupted = rig.request(2, '100');
  await pool.begin(id, interrupted.requestId);
  await rig.buyer.begin(interrupted);
  await rig.seller().reserve(interrupted, rig.terms.buyerNodeId);
  const bill = await rig.seller().finish(interrupted.requestId, '10');
  await rig.buyer.approve(bill, '10');
  const token = 'synthetic-buyer-owner-token';
  const host = await startFreeBuyerHttp(
    async () => assert.fail('unexpected inference'),
    {
      selection: {
        modelId: MODEL_IDS.QWEN3_0_6B,
        variant: null,
        quantization: null,
      },
      maxTokens: 1,
    },
    {
      port: 0,
      token,
      desktopPolicy: {
        maxAtomic: '100',
        network: DEVNET,
        mint: DEVNET_USDC,
        payer: rig.terms.buyer,
        totalDepositAtomic: total,
        depositAtomic: '10000',
        lifetimeMs: 3600000,
      },
      reconcilePool: async () => {
        await rig.buyer.reconcile(rig.sellerOptions.observe);
        if (!(await pool.resolve(id))) throw new Error('still pending');
      },
    },
  );
  t.after(host.close);
  const client = new X402Client(
    new X402Budget({ read: async () => undefined, write: async () => {} }),
  );
  await client.connect(host.url, token);
  const policy = client.policy();
  assert.ok(policy);
  await assert.rejects(client.reconcileReviewedPool(policy));
  assert.equal(await next(), false);
  rig.time(rig.terms.expiresAt);
  await rig.seller().close();
  assert.equal(await next(), false);
  await client.reconcileReviewedPool(policy);
  assert.equal(await next(), true);
});

void test('checking a clean pool credits an expired seller refund before selecting another seller', async (t) => {
  const fixture = await multisellerLoopback('15000');
  const manager = createBuyerSessionPool(fixture.options);
  t.after(async () => {
    await manager.close();
    await fixture.close();
  });
  const offer = fixture.offers[0]!;
  await manager.execute(await offer.quote(1), offer.input, t.signal);
  const next = () =>
    poolAllowsSellerDeposit(
      fixture.paths,
      fixture.b.terms.sellerNodeId,
      '15000',
      '10000',
    );
  fixture.a.time(fixture.a.terms.expiresAt);
  await fixture.a.seller().close();
  assert.equal(await next(), false);
  await checkDesktopPool(manager, () => false);
  assert.equal(await next(), true);
});
