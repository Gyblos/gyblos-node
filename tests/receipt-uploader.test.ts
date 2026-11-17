// Drives the receipt uploader end to end against the real metrics collector app (memory storage) with
// a real private receipt store and ephemeral signers; no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import { COLLECTOR_LIMITERS } from '@gyblos/metrics-collector/constants';
import { createMemoryStorage } from '@gyblos/metrics-collector/storage-memory';
import { RECEIPT_UPLOADER_OUTCOMES as OUTCOMES } from '@gyblos/node/constants';
import { createReceiptUploader } from '@gyblos/node/receipt-uploader';
import { openReceiptStore } from '@gyblos/node/receipts';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
} from '@gyblos/protocol/receipt-upload';

import { fakeLimiter } from './support/metrics-collector';
import { receiptUploadFixture } from './support/receipt-upload-fixture';

const URL_BASE = 'https://collector.test/v1';
const CLIENT = {
  kind: RECEIPT_UPLOAD_CLIENTS.SELLER_NODE,
  appVersion: '0.1.0-beta.12',
  platform: RECEIPT_UPLOAD_PLATFORMS.LINUX,
  arch: RECEIPT_UPLOAD_ARCHES.X64,
};

function collectorFetch(
  now: () => number,
  options: { failFirst?: number } = {},
) {
  const memory = createMemoryStorage();
  const app = createMetricsCollector({
    storage: memory.storage,
    limiters: {
      [COLLECTOR_LIMITERS.IP]: fakeLimiter(),
      [COLLECTOR_LIMITERS.NODE]: fakeLimiter(),
      [COLLECTOR_LIMITERS.GLOBAL]: fakeLimiter(),
    },
    now,
  });
  let failures = options.failFirst ?? 0;
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(String(input));
    if (failures > 0) {
      failures -= 1;
      return new Response('{"error":"COLLECTOR_UNAVAILABLE"}', { status: 503 });
    }
    return app.request(String(input), init);
  };
  return { memory, fetcher, calls };
}

async function storeWith(
  fixture: Awaited<ReturnType<typeof receiptUploadFixture>>,
  count: number,
) {
  const store = openReceiptStore({
    ...fixture.options,
    maxEntries: 256,
    maxBytes: 1_048_576,
    retentionMs: 604_800_000,
  });
  for (let index = 1; index <= count; index++)
    await store.put(await fixture.next(index));
  return store;
}

void test('pending receipts are uploaded, acknowledged and not sent again', async () => {
  const fixture = await receiptUploadFixture();
  try {
    const store = await storeWith(fixture, 3);
    const now = () => 1700000000100;
    const { memory, fetcher, calls } = collectorFetch(now);
    const uploader = createReceiptUploader({
      store,
      nodeId: fixture.seller.nodeId,
      role: P2P_ROLES.SELLER,
      client: CLIENT,
      signer: fixture.seller.sign,
      url: URL_BASE,
      fetch: fetcher,
      now,
    });
    assert.deepEqual(await uploader.uploadOnce(), {
      outcome: OUTCOMES.UPLOADED,
      uploaded: 3,
    });
    assert.deepEqual(calls, [`${URL_BASE}/receipts`]);
    assert.equal(memory.entries.size, 3);
    assert.equal(memory.envelopes[0]!.client.kind, CLIENT.kind);
    assert.deepEqual(await store.listPending(), []);
    assert.deepEqual(await uploader.uploadOnce(), {
      outcome: OUTCOMES.IDLE,
      uploaded: 0,
    });
    assert.equal(calls.length, 1);
  } finally {
    await fixture.close();
  }
});

void test('an unavailable collector keeps receipts pending for a later retry', async () => {
  const fixture = await receiptUploadFixture();
  try {
    const store = await storeWith(fixture, 2);
    const now = () => 1700000000100;
    const { memory, fetcher } = collectorFetch(now, { failFirst: 1 });
    const uploader = createReceiptUploader({
      store,
      nodeId: fixture.seller.nodeId,
      role: P2P_ROLES.SELLER,
      client: CLIENT,
      signer: fixture.seller.sign,
      url: URL_BASE,
      fetch: fetcher,
      now,
    });
    assert.equal((await uploader.uploadOnce()).outcome, OUTCOMES.RETRY);
    assert.equal((await store.listPending()).length, 2);
    assert.equal((await uploader.uploadOnce()).outcome, OUTCOMES.UPLOADED);
    assert.equal(memory.entries.size, 2);
  } finally {
    await fixture.close();
  }
});

void test('a node with a wrong clock corrects it from the collector and still uploads', async () => {
  const fixture = await receiptUploadFixture();
  try {
    const store = await storeWith(fixture, 1);
    // The collector's clock is an hour ahead of this node's.
    const { memory, fetcher, calls } = collectorFetch(() => 1700003600100);
    const uploader = createReceiptUploader({
      store,
      nodeId: fixture.seller.nodeId,
      role: P2P_ROLES.SELLER,
      client: CLIENT,
      signer: fixture.seller.sign,
      url: URL_BASE,
      fetch: fetcher,
      now: () => 1700000000100,
    });
    assert.equal((await uploader.uploadOnce()).outcome, OUTCOMES.UPLOADED);
    assert.equal(calls.length, 2);
    assert.equal(memory.entries.size, 1);
    // The skew the node had is recorded with its corrected envelope.
    assert.equal(memory.envelopes[0]!.sentAt, 1700003600100);
  } finally {
    await fixture.close();
  }
});

void test('a network failure never throws to the caller', async () => {
  const fixture = await receiptUploadFixture();
  try {
    const store = await storeWith(fixture, 1);
    const uploader = createReceiptUploader({
      store,
      nodeId: fixture.seller.nodeId,
      role: P2P_ROLES.SELLER,
      client: CLIENT,
      signer: fixture.seller.sign,
      url: URL_BASE,
      fetch: () => Promise.reject(new TypeError('offline')),
      now: () => 1700000000100,
    });
    assert.equal((await uploader.uploadOnce()).outcome, OUTCOMES.RETRY);
    assert.equal((await store.listPending()).length, 1);
    await uploader.close();
  } finally {
    await fixture.close();
  }
});
