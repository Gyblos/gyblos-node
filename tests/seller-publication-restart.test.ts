// Proves restart/reopening against the real index and its tombstone, using only ephemeral local state.
import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchSellers, publishRecord } from '@gyblos/discovery-http';
import { createSellerRecords } from '@gyblos/node/public-records';
import { openSellerSequence } from '@gyblos/node/public-sequence';
import { createSellerPublisher } from '@gyblos/node/publisher';

import { publicationIndex } from './support/publication-index.js';
import { sellerPublicationFixture } from './support/seller-publication.js';

void test('restarted seller keeps the persisted high-water mark and only a newer catalog can reopen a withdrawn HTTP listing', async () => {
  const run = await sellerPublicationFixture();
  const index = await publicationIndex(run.context.now);
  const publish = async (
    record: Parameters<typeof publishRecord>[0]['record'],
    signal: AbortSignal,
  ) => {
    await publishRecord({
      baseUrl: index.baseUrl,
      record,
      signal,
      fetch: globalThis.fetch,
    });
  };
  const first = createSellerPublisher({
    records: run.records,
    canPublish: () => true,
    now: run.context.now,
    publish,
  });
  let second: ReturnType<typeof createSellerPublisher> | undefined;
  try {
    await first.tick();
    const old = run.records.current();
    await first.stop();
    await assert.rejects(publish(old, new AbortController().signal));
    const sequence = await openSellerSequence({
      environment: run.environment,
      nodeId: run.catalog.nodeId,
      initialFloor: 1,
    });
    const records = await createSellerRecords({
      template: run.catalog,
      sequence,
      signer: run.nodeSigner,
      now: run.context.now,
      validUntil: () => run.context.readiness().validUntil,
    });
    assert.ok(records.current().record.sequence > old.record.sequence + 1);
    second = createSellerPublisher({
      records,
      canPublish: () => true,
      now: run.context.now,
      publish,
    });
    assert.equal(await second.tick(), true);
    const listed = await fetchSellers({
      baseUrl: index.baseUrl,
      model: run.catalog.models[0]!.modelId,
      fetch: globalThis.fetch,
      now: run.context.now,
    });
    assert.equal(listed.sellers.length, 1);
    assert.ok(listed.sellers[0]!.catalog.sequence > old.record.sequence);
  } finally {
    await first.stop();
    await second?.stop();
    await index.close();
    await run.close();
  }
});
