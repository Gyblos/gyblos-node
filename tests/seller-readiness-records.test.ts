// Binds public records to cached observation generations, including failures shorter than a publish tick.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSellerControlService } from '@gyblos/node/control';
import { createSellerRecords } from '@gyblos/node/public-records';
import {
  CONTROL_CODES,
  CONTROL_METHODS,
  CONTROL_VERSION,
} from '@gyblos/protocol/constants';
import type { Signer } from '@gyblos/protocol/signing';

import { sellerPublicationFixture } from './support/seller-publication.js';

async function fixture() {
  const source = await sellerPublicationFixture();
  let sequence = source.records.current().record.sequence;
  let sign: Signer = source.nodeSigner;
  const records = await createSellerRecords({
    template: source.catalog,
    signer: (bytes) => sign(bytes),
    sequence: { next: async () => ++sequence },
    now: source.context.now,
    validUntil: () => source.context.readiness().validUntil,
    readiness: source.context.readiness,
    catalogMs: 6000,
    renewBeforeMs: 2000,
  });
  const service = createSellerControlService({
    ...source,
    records,
    context: { ...source.context, catalog: records.current() },
  });
  return {
    ...source,
    records,
    service,
    setSigner: (value: Signer) => {
      sign = value;
    },
  };
}

void test('expired or busy observations immediately block cached catalogs and presence before publisher tick', async () => {
  for (const mode of ['expired', 'busy', 'future']) {
    const run = await fixture();
    try {
      const now = run.context.now();
      if (mode === 'expired') run.setReadiness({ validUntil: now });
      if (mode === 'busy') run.setReadiness({ busy: true });
      if (mode === 'future') run.setReadiness({ observedAt: now + 1 });
      assert.throws(() => run.records.current());
      for (const method of [
        CONTROL_METHODS.CATALOG,
        CONTROL_METHODS.PRESENCE,
      ]) {
        const response = await run.service.respond(
          {
            version: CONTROL_VERSION,
            requestId: 'a'.repeat(32),
            method,
            params: {},
          },
          run.request.params.buyerNodeId,
          new AbortController().signal,
        );
        assert.ok('error' in response);
      }
    } finally {
      await run.close();
    }
  }
});

void test('failure and recovery between ticks require a higher catalog even when the old signature has not expired', async () => {
  const run = await fixture();
  try {
    const before = run.records.current();
    run.setReadiness({ generation: 2, validUntil: 0 });
    assert.throws(() => run.records.current());
    run.setReadiness({ generation: 3, validUntil: run.context.now() + 20000 });
    assert.throws(() => run.records.current());
    const after = await run.records.refresh();
    assert.ok(after.record.sequence > before.record.sequence);
    assert.notEqual(after.signature, before.signature);
    assert.equal(run.records.current(), after);
  } finally {
    await run.close();
  }
});

void test('a changed observation during asynchronous presence signing rejects the late signed result', async () => {
  const run = await fixture();
  try {
    let finish!: () => void;
    run.setSigner(async (bytes) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return run.nodeSigner(bytes);
    });
    const presence = run.records.presence();
    const rejected = assert.rejects(presence, { code: CONTROL_CODES.STALE });
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    run.setReadiness({ generation: 2 });
    finish();
    await rejected;
  } finally {
    await run.close();
  }
});

void test('a catalog lookup rechecks readiness after asynchronous signature verification', async () => {
  const run = await fixture();
  try {
    const response = run.service.respond(
      {
        version: CONTROL_VERSION,
        requestId: 'b'.repeat(32),
        method: CONTROL_METHODS.CATALOG,
        params: {},
      },
      run.request.params.buyerNodeId,
      new AbortController().signal,
    );
    run.setReadiness({ generation: 2, validUntil: 0 });
    assert.ok('error' in (await response));
  } finally {
    await run.close();
  }
});
