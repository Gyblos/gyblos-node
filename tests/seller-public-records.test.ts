// Verifies one durable namespace across control presence, catalog rotation and withdrawal; no engine/payments.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSellerControlService } from '@gyblos/node/control';
import { createSellerRecords } from '@gyblos/node/public-records';
import { openSellerSequence } from '@gyblos/node/public-sequence';
import {
  CONTROL_CODES,
  CONTROL_METHODS,
  CONTROL_VERSION,
  PUBLIC_RECORD_KINDS,
} from '@gyblos/protocol/constants';
import { catalogDigestV2, verifyPublicV2 } from '@gyblos/protocol/public-v2';

import { controlFixture } from './support/control-fixture.js';

async function fixture() {
  const source = await controlFixture();
  const directory = await mkdtemp(join(tmpdir(), 'seller-records-'));
  const sequence = await openSellerSequence({
    environment: { GYBLOS_HOME: directory },
    nodeId: source.catalog.nodeId,
    initialFloor: source.catalog.sequence + 1,
  });
  const records = await createSellerRecords({
    template: source.catalog,
    sequence,
    signer: source.nodeSigner,
    now: source.context.now,
    validUntil: () => source.context.readiness().validUntil,
    catalogMs: 4000,
    renewBeforeMs: 1000,
  });
  return {
    ...source,
    records,
    sequence,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
void test('catalog, publisher and control presence share strictly increasing durable sequence reservations', async () => {
  const run = await fixture();
  try {
    const catalog = run.records.current();
    const presence = await run.records.presence();
    const service = createSellerControlService({
      ...run,
      context: { ...run.context, catalog },
      records: run.records,
    });
    const result = await service.respond(
      {
        version: CONTROL_VERSION,
        requestId: 'c'.repeat(32),
        method: CONTROL_METHODS.PRESENCE,
        params: {},
      },
      run.request.params.buyerNodeId,
      new AbortController().signal,
    );
    assert.ok(
      'result' in result &&
        result.result &&
        result.result.method === CONTROL_METHODS.PRESENCE,
    );
    assert.ok(
      result.result.presence.record.sequence > presence.record.sequence,
    );
    const withdrawal = await run.records.withdraw();
    assert.ok(withdrawal);
    assert.ok(
      withdrawal.record.sequence > result.result.presence.record.sequence,
    );
    assert.throws(() => run.records.current());
    await assert.rejects(run.records.presence());
    const next = await run.records.refresh(true);
    assert.ok(next.record.sequence > withdrawal.record.sequence);
  } finally {
    await run.close();
  }
});
void test('catalog rotation never extends observed readiness and old catalog quotes become stale', async () => {
  const run = await fixture();
  try {
    const old = run.records.current();
    const service = createSellerControlService({
      ...run,
      context: { ...run.context, catalog: old },
      records: run.records,
    });
    run.request.params.catalogDigest = await catalogDigestV2(old.record);
    run.setNow(run.context.now() + 3500);
    const fresh = await run.records.refresh();
    assert.ok(fresh.record.sequence > old.record.sequence);
    const stale = await service.respond(
      run.request,
      run.request.params.buyerNodeId,
      new AbortController().signal,
    );
    assert.ok(stale.error);
    assert.equal(stale.error.code, CONTROL_CODES.STALE);
    assert.ok(fresh.record.expiresAt <= run.context.readiness().validUntil);
    const record = await verifyPublicV2(await run.records.presence(), {
      owner: run.context.owner,
      nodeId: run.catalog.nodeId,
      now: run.context.now(),
      catalog:
        fresh.record.kind === PUBLIC_RECORD_KINDS.CATALOG
          ? fresh.record
          : undefined,
    });
    assert.equal(record.kind, PUBLIC_RECORD_KINDS.PRESENCE);
    run.setNow(run.context.readiness().validUntil);
    await assert.rejects(run.records.refresh());
    assert.throws(() => run.records.current());
  } finally {
    await run.close();
  }
});
void test('failed durable reservation disables records before a signature can escape', async () => {
  const source = await controlFixture();
  let signatures = 0;
  let fail = false;
  let sequence = source.catalog.sequence;
  const records = await createSellerRecords({
    template: source.catalog,
    sequence: {
      next: async () => {
        if (fail) throw new Error('synthetic persistence failure');
        return ++sequence;
      },
    },
    signer: async (bytes) => {
      signatures++;
      return source.nodeSigner(bytes);
    },
    now: source.context.now,
    validUntil: () => source.context.readiness().validUntil,
  });
  fail = true;
  await assert.rejects(records.presence());
  assert.equal(signatures, 1);
  assert.throws(() => records.current());
});

void test('a quote signing during retirement is never returned after the local catalog is disabled', async () => {
  const run = await fixture();
  let started = () => {};
  let release = () => {};
  const signing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    run.request.params.catalogDigest = await catalogDigestV2(
      run.records.current().record,
    );
    const service = createSellerControlService({
      ...run,
      context: { ...run.context, catalog: run.records.current() },
      records: run.records,
      ownerSigner: async (bytes) => {
        started();
        await held;
        return run.ownerSigner(bytes);
      },
    });
    const pending = service.respond(
      run.request,
      run.request.params.buyerNodeId,
      new AbortController().signal,
    );
    await signing;
    await run.records.withdraw();
    release();
    const result = await pending;
    assert.ok(result.error);
    assert.equal(result.error.code, CONTROL_CODES.STALE);
  } finally {
    release();
    await run.close();
  }
});
