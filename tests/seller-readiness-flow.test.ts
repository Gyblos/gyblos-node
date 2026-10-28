// Exercises renewable seller availability through HTTP discovery and the Iroh stream contract.
// Disposable identities, homes and a synthetic engine never execute payments or contact a public index.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createBuyerControlClient } from '@gyblos/buyer/control';
import { fetchSellers, publishRecord } from '@gyblos/discovery-http';
import { createSellerControlService } from '@gyblos/node/control';
import { observeControlReadiness } from '@gyblos/node/control-readiness';
import { createSellerRecords } from '@gyblos/node/public-records';
import { openSellerSequence } from '@gyblos/node/public-sequence';
import { createSellerPublisher } from '@gyblos/node/publisher';
import { ENGINE_DONE_REASONS } from '@gyblos/protocol/constants';
import type { Engine } from '@gyblos/protocol/engine';

import { controlLoopback } from './support/control-loopback';
import { publicationIndex } from './support/publication-index';
import { sellerPublicationFixture } from './support/seller-publication';

void test('seller expiry, failed check, recovery and busy transitions reach fresh verified quotes without inference from queries', async () => {
  const run = await sellerPublicationFixture();
  const model = run.context.models[0]!.model;
  const initialDeadline = run.context.readiness().validUntil;
  let fail = false;
  let checks = 0;
  let generations = 0;
  let finish!: () => void;
  const engine: Engine = {
    describe: async () => model,
    capabilities: () => run.context.models[0]!.capabilities,
    generate: async () => {
      generations++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        text: '',
        finishReason: ENGINE_DONE_REASONS.STOP,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalDurationNs: 0,
          loadDurationNs: 0,
          inputDurationNs: 0,
          outputDurationNs: 0,
        },
      };
    },
  };
  const observation = observeControlReadiness(
    engine,
    initialDeadline,
    run.context.now,
    {
      model,
      renewBeforeMs: 2000,
      timeoutMs: 1000,
      check: async () => {
        checks++;
        if (fail) throw new Error('Synthetic unavailable engine');
        return { model, offerExpiresAt: run.context.now() + 20000 };
      },
    },
  );
  const records = await createSellerRecords({
    template: () => run.catalog,
    signer: run.nodeSigner,
    sequence: await openSellerSequence({
      environment: run.environment,
      nodeId: run.catalog.nodeId,
    }),
    now: run.context.now,
    validUntil: () => observation.readiness().validUntil,
    readiness: observation.readiness,
    catalogMs: 6000,
    renewBeforeMs: 2000,
  });
  const service = createSellerControlService({
    ...run,
    records,
    context: {
      ...run.context,
      catalog: records.current(),
      readiness: observation.readiness,
    },
    monotonic: run.context.now,
  });
  const wire = await controlLoopback(service, run.request.params.buyerNodeId);
  const client = createBuyerControlClient(
    { ...wire.transport, remoteNodeId: run.catalog.nodeId },
    { ...run.trust(), now: run.context.now },
  );
  const index = await publicationIndex(run.context.now, run.catalog.nodeId);
  const publisher = createSellerPublisher({
    records,
    now: run.context.now,
    canPublish: () => {
      const state = observation.readiness();
      return !state.busy && state.validUntil > run.context.now();
    },
    publish: async (record, signal) => {
      await publishRecord({
        baseUrl: index.baseUrl,
        record,
        signal,
        fetch: globalThis.fetch,
      });
    },
  });
  const listing = () =>
    fetchSellers({
      baseUrl: index.baseUrl,
      model: run.catalog.models[0]!.modelId,
      fetch: globalThis.fetch,
      now: run.context.now,
    });
  const {
    buyerNodeId: _peer,
    catalogDigest: _digest,
    ...params
  } = run.request.params;
  try {
    assert.equal(await publisher.tick(), true);
    assert.equal((await listing()).sellers.length, 1);
    const original = await client.getCatalog();
    await client.getPresence();
    await client.requestOffer(params);
    assert.equal(checks, 0);
    assert.equal(generations, 0);

    run.setNow(initialDeadline);
    await assert.rejects(client.getCatalog());
    assert.equal(await publisher.tick(), false);
    assert.equal((await listing()).sellers.length, 0);
    fail = true;
    assert.equal(await observation.tick(), false);
    await assert.rejects(client.getCatalog());

    fail = false;
    assert.equal(await observation.tick(), true);
    await records.refresh();
    assert.equal(await publisher.tick(), true);
    assert.equal((await listing()).sellers.length, 1);
    const recovered = await client.getCatalog();
    assert.ok(recovered.record.sequence > original.record.sequence);
    const quote = await client.requestOffer(params);
    assert.ok(quote.offer.expiresAt > initialDeadline);
    assert.ok(quote.offer.expiresAt <= observation.readiness().validUntil);
    assert.equal(checks, 2);
    assert.equal(generations, 0);

    const generating = observation.engine.generate({
      prompt: 'synthetic',
      maxTokens: 1,
    });
    assert.equal(await observation.tick(), false);
    assert.equal(checks, 2);
    await assert.rejects(client.getCatalog());
    assert.equal(await publisher.tick(), false);
    assert.equal((await listing()).sellers.length, 0);
    finish();
    await generating;
    await records.refresh();
    assert.equal(await publisher.tick(), true);
    const idle = await client.getCatalog();
    assert.ok(idle.record.sequence > recovered.record.sequence);
    await client.requestOffer(params);
    assert.equal(generations, 1);
    await observation.stop();
    await assert.rejects(client.getCatalog());
  } finally {
    await observation.stop?.();
    await publisher.stop();
    await client.close();
    await wire.close();
    await index.close();
    await run.close();
  }
});
