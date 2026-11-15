// A snapshot operation may settle after its nominal deadline; eligibility uses the actual final clock.
// Signed in-memory control responses exercise public selection without sockets or external state.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import type { LocalSellerStats } from '@gyblos/buyer/selection-stats';
import { SELLER_BADGES } from '@gyblos/core/constants';
import { createSellerControlService } from '@gyblos/node/control';

import { controlFixture } from './support/control-fixture';

void test('a seller whose cooldown ends while identity work settles remains eligible', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'buyer-cooldown-overrun-'));
  const originalDirectory = process.cwd();
  const originalHome = process.env.GYBLOS_HOME;
  const originalLabHome = process.env.GYBLOS_LAB_HOME;
  process.chdir(directory);
  process.env.GYBLOS_HOME = join(directory, 'product');
  process.env.GYBLOS_LAB_HOME = join(directory, 'lab');
  context.after(async () => {
    process.chdir(originalDirectory);
    if (originalHome === undefined) delete process.env.GYBLOS_HOME;
    else process.env.GYBLOS_HOME = originalHome;
    if (originalLabHome === undefined) delete process.env.GYBLOS_LAB_HOME;
    else process.env.GYBLOS_LAB_HOME = originalLabHome;
    await rm(directory, { recursive: true, force: true });
  });
  const source = await controlFixture(true);
  const service = createSellerControlService({
    context: source.context,
    ownerSigner: source.ownerSigner,
    nodeSigner: source.nodeSigner,
  });
  const {
    buyer,
    buyerNodeId,
    catalogDigest: _digest,
    ...request
  } = source.request.params;
  const healthy = {
    owner: source.catalog.owner,
    nodeId: source.catalog.nodeId,
    relayUrl: null,
    directAddresses: [],
  };
  const other = { ...healthy, nodeId: '3'.repeat(64) };
  const initialNow = source.context.now();
  const stats = new Map<string, LocalSellerStats>([
    [
      healthy.nodeId,
      {
        successes: 0,
        failures: 1,
        latencyMs: 0,
        waitAccuracy: null,
        cooldownUntil: initialNow + 1500,
        quotedWaitMs: null,
        observedWaitMs: null,
      },
    ],
  ]);
  const attempts: string[] = [];
  const result = await selectVerifiedBuyerQuote(
    {
      request: {
        ...request,
        lowestReasoning: null,
        minimumBadge: SELLER_BADGES.DECLARED_USAGE,
        retention: [source.catalog.dataPolicy.retention],
      },
      sellers: [healthy, other],
      quoteWindowMs: 2000,
    },
    {
      buyer,
      stats,
      now: source.context.now,
      random: () => 0,
      snapshotMs: 1000,
      verifyIdentity: async (seller) => {
        if (seller.nodeId === healthy.nodeId) return true;
        // Identity/state work owns its settlement and can outlast the selection's snapshot timeout.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        source.setNow(initialNow + 2000);
        throw new Error(
          'Synthetic identity operation settled after its deadline',
        );
      },
      connect: async (seller) => {
        attempts.push(seller.nodeId);
        assert.equal(seller.nodeId, healthy.nodeId);
        return createBuyerControlClient(
          {
            localNodeId: buyerNodeId,
            remoteNodeId: healthy.nodeId,
            exchange: (value, signal) =>
              service.respond(
                value,
                buyerNodeId,
                signal ?? new AbortController().signal,
              ),
            close: async () => {},
          },
          { ...source.trust(), now: source.context.now },
        );
      },
    },
  );
  assert.equal(
    result.ok,
    true,
    'the recovered seller is the only eligible seller',
  );
  assert.deepEqual(attempts, [healthy.nodeId]);
});
