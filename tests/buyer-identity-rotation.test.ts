// Registry-authorized owner changes preserve the node-global public replay floor.
// These metadata-only cases never resolve identity or perform inference/payment operations.
import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeDiscoveryRow } from '@gyblos/buyer/discovery-state';
import { buyerDiscoveryState } from '@gyblos/buyer/discovery-storage';
import { catalogDigestV2 } from '@gyblos/protocol/public-v2';

import { discoveryHome, discoveryRun } from './support/buyer-discovery';

void test('independently authorized owner rotation needs a later catalog and retains old public replay floors', async () => {
  const home = await discoveryHome();
  const run = await discoveryRun();
  try {
    const held = await buyerDiscoveryState(home.environment);
    assert.equal(await home.state.observe(run.known), true);
    await held.observe(run.known);
    const owner = '11111111111111111111111111111111';
    const changed = {
      ...run.known,
      catalog: { ...run.known.catalog, owner, sequence: 10 },
      presence: { ...run.known.presence!, owner, sequence: 11 },
    };
    assert.equal(await home.state.observe(changed), false);
    assert.equal(
      await home.state.observe(
        {
          ...changed,
          catalog: { ...changed.catalog, sequence: run.known.catalog.sequence },
        },
        { allowOwnerChange: true },
      ),
      false,
    );
    assert.equal(
      await home.state.observe(changed, { allowOwnerChange: true }),
      true,
    );
    assert.equal(
      await held.permits(
        owner,
        run.catalog.nodeId,
        await catalogDigestV2(changed.catalog),
        run.context.now(),
      ),
      true,
    );
    const restart = await buyerDiscoveryState(home.environment);
    assert.equal(
      await restart.observe(run.known, { allowOwnerChange: true }),
      false,
    );
    assert.equal(
      restart.eligible(
        [{ owner, nodeId: run.catalog.nodeId }],
        run.context.now(),
      ).length,
      1,
    );
  } finally {
    await run.wire.close();
    await home.close();
  }
});
void test('owner rotation never drops withdrawal and conflict floors', () => {
  const held = {
    owner: '11111111111111111111111111111111',
    nodeId: '01'.repeat(32),
    highWater: 20,
    catalogSequence: 10,
    catalogDigest: '02'.repeat(32),
    catalogExpiresAt: 100,
    presenceDigest: '03'.repeat(32),
    presenceExpiresAt: 100,
    withdrawnThrough: 19,
    conflictedThrough: 20,
  };
  const incoming = {
    ...held,
    owner: 'new expected owner',
    highWater: 22,
    catalogSequence: 21,
    withdrawnThrough: 0,
    conflictedThrough: 0,
  };
  assert.equal(mergeDiscoveryRow(held, incoming).accepted, false);
  const result = mergeDiscoveryRow(held, incoming, true);
  assert.equal(result.accepted, true);
  assert.equal(result.row.withdrawnThrough, 19);
  assert.equal(result.row.conflictedThrough, 20);
});
