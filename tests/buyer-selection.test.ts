// Verifies authenticated static selection and signed quote decisions over real loopback streams.
// Every authorization is synthetic; no payment adapter or real role data is used.
import assert from 'node:assert/strict';
import test from 'node:test';

import { BUYER_SELECTION_CODES } from '@gyblos/buyer/constants';
import { selectVerifiedBuyerQuote } from '@gyblos/buyer/selection';
import { parseBuyerSelectionConfig } from '@gyblos/buyer/selection-config';
import { SELLER_SELECTION_CODES } from '@gyblos/core/constants';
import { PUBLIC_RECORD_KINDS } from '@gyblos/protocol/constants';
import { catalogDigestV2, signPublicV2 } from '@gyblos/protocol/public-v2';

import { selectionFixture } from './support/buyer-selection';

void test('pinned seller cooldown is returned with cooldownUntil for the UI', async () => {
  const run = await selectionFixture();
  try {
    const cooldownUntil = run.context.now() + 5000;
    run.dependencies.stats.set(run.catalog.nodeId, {
      successes: 1,
      failures: 1,
      latencyMs: 10,
      waitAccuracy: null,
      cooldownUntil,
      quotedWaitMs: null,
      observedWaitMs: null,
    });
    assert.deepEqual(
      await selectVerifiedBuyerQuote(
        { ...run.config, pinnedNodeId: run.catalog.nodeId },
        run.dependencies,
      ),
      {
        ok: false,
        code: SELLER_SELECTION_CODES.PINNED_IN_COOLDOWN,
        cooldownUntil,
      },
    );
    assert.equal(run.wire.queries, 2);
  } finally {
    await run.wire.close();
  }
});
void test('withdrawal must reference the exact verified catalog before selection', async () => {
  const run = await selectionFixture();
  try {
    const withdrawal = await signPublicV2(
      {
        schemaVersion: run.catalog.schemaVersion,
        kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
        owner: run.catalog.owner,
        nodeId: run.catalog.nodeId,
        sequence: 10,
        issuedAt: run.context.now(),
        expiresAt: run.context.now() + 10000,
        catalogDigest: 'f'.repeat(64),
      },
      run.nodeSigner,
    );
    run.config.sellers[0]!.withdrawal = withdrawal;
    assert.equal(
      (await selectVerifiedBuyerQuote(run.config, run.dependencies)).ok,
      false,
    );
    assert.equal(run.wire.queries, 2);
  } finally {
    await run.wire.close();
  }
});
void test('valid withdrawal tombstones the catalog; invalid static config is rejected', async () => {
  const run = await selectionFixture();
  try {
    run.config.sellers[0]!.withdrawal = await signPublicV2(
      {
        schemaVersion: run.catalog.schemaVersion,
        kind: PUBLIC_RECORD_KINDS.WITHDRAWAL,
        owner: run.catalog.owner,
        nodeId: run.catalog.nodeId,
        sequence: 10,
        issuedAt: run.context.now(),
        expiresAt: run.context.now() + 10000,
        catalogDigest: await catalogDigestV2(run.catalog),
      },
      run.nodeSigner,
    );
    assert.equal(
      (await selectVerifiedBuyerQuote(run.config, run.dependencies)).ok,
      false,
    );
    assert.throws(
      () => parseBuyerSelectionConfig({ ...run.config, unknown: true }),
      { code: BUYER_SELECTION_CODES.INVALID },
    );
    assert.deepEqual(parseBuyerSelectionConfig(run.config), run.config);
  } finally {
    await run.wire.close();
  }
});

void test('a slow snapshot cannot discard a healthy seller or consume its quote window', async () => {
  const run = await selectionFixture();
  try {
    const healthy = run.config.sellers[0]!;
    const slow = { ...healthy, nodeId: '3'.repeat(64) };
    const result = await selectVerifiedBuyerQuote(
      { ...run.config, sellers: [healthy, slow] },
      {
        ...run.dependencies,
        snapshotMs: 500,
        async connect(seller) {
          if (seller.nodeId === healthy.nodeId) return run.client;
          return {
            async getCatalog(signal?: AbortSignal) {
              await new Promise<void>((_resolve, reject) =>
                signal?.addEventListener(
                  'abort',
                  () => reject(new Error('synthetic timeout')),
                  { once: true },
                ),
              );
              throw new Error('unreachable');
            },
            async getPresence() {
              throw new Error('unused');
            },
            async requestOffer() {
              throw new Error('unused');
            },
            async close() {},
          };
        },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(run.wire.queries, 3);
  } finally {
    await run.wire.close();
  }
});

void test('a buffered downgrade that expires while exact offers are pending cannot be returned', async () => {
  const exact = await selectionFixture();
  const lower = await selectionFixture();
  try {
    const { REASONING_LEVELS } = await import('@gyblos/protocol/constants');
    lower.catalog.models[0]!.reasoning = [REASONING_LEVELS.OFF];
    lower.context.catalog = await signPublicV2(lower.catalog, lower.nodeSigner);
    let now = exact.context.now();
    let refuse!: () => void;
    const refused = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    const result = await selectVerifiedBuyerQuote(
      {
        request: {
          ...exact.config.request,
          reasoning: REASONING_LEVELS.LOW,
          lowestReasoning: REASONING_LEVELS.OFF,
        },
        sellers: [...exact.config.sellers, ...lower.config.sellers],
      },
      {
        ...exact.dependencies,
        now: () => now,
        async connect(seller) {
          if (seller.nodeId === exact.catalog.nodeId)
            return {
              getCatalog: exact.client.getCatalog.bind(exact.client),
              getPresence: exact.client.getPresence.bind(exact.client),
              close: exact.client.close.bind(exact.client),
              async requestOffer() {
                await refused;
                throw new Error('synthetic busy');
              },
            };
          return {
            getCatalog: lower.client.getCatalog.bind(lower.client),
            getPresence: lower.client.getPresence.bind(lower.client),
            close: lower.client.close.bind(lower.client),
            async requestOffer(params, signal) {
              const quote = await lower.client.requestOffer(params, signal);
              now = quote.offer.expiresAt;
              refuse();
              return quote;
            },
          };
        },
      },
    );
    assert.deepEqual(result, {
      ok: false,
      code: BUYER_SELECTION_CODES.NO_OFFER,
    });
  } finally {
    await exact.wire.close();
    await lower.wire.close();
  }
});
