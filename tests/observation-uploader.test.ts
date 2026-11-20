// Drives the node's observation buffer and the uploader's observation path end to end against the real
// metrics collector app (memory storage), with ephemeral signers and no network.
import assert from 'node:assert/strict';
import test from 'node:test';

import { RECEIPT_UPLOADER } from '@gyblos/config';
import { createMetricsCollector } from '@gyblos/metrics-collector/app';
import { COLLECTOR_LIMITERS } from '@gyblos/metrics-collector/constants';
import { createMemoryStorage } from '@gyblos/metrics-collector/storage-memory';
import { RECEIPT_UPLOADER_OUTCOMES as OUTCOMES } from '@gyblos/node/constants';
import { createObservationBuffer } from '@gyblos/node/observation-buffer';
import { createReceiptUploader } from '@gyblos/node/receipt-uploader';
import { uploadObservationBuffer } from '@gyblos/node/receipt-uploader-startup';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
} from '@gyblos/protocol/receipt-upload';
import {
  TELEMETRY_EVENTS,
  TELEMETRY_REFUSALS,
  type TelemetryEvent,
} from '@gyblos/protocol/telemetry';

import { fakeLimiter } from './support/metrics-collector';
import { receiptSigner } from './support/receipt-fixture';

const NOW = 1_800_000_000_000;
const SELECTION = {
  modelId: 'synthetic/model',
  variant: null,
  quantization: null,
};

function unserved(buyerNodeId: string, at = NOW - 10): TelemetryEvent {
  return {
    type: TELEMETRY_EVENTS.UNSERVED,
    at,
    role: P2P_ROLES.BUYER,
    buyerNodeId,
    selection: SELECTION,
    streaming: true,
    requestId: null,
    sellerNodeId: null,
    engineKind: null,
  };
}
function refused(buyerNodeId: string): TelemetryEvent {
  return {
    type: TELEMETRY_EVENTS.REFUSED,
    at: NOW - 5,
    role: P2P_ROLES.BUYER,
    buyerNodeId,
    selection: SELECTION,
    streaming: false,
    requestId: '33'.repeat(16),
    refusal: TELEMETRY_REFUSALS.CONNECT_FAILED,
    sellerNodeId: null,
    engineKind: null,
  };
}

function collector() {
  const memory = createMemoryStorage();
  const app = createMetricsCollector({
    storage: memory.storage,
    limiters: {
      [COLLECTOR_LIMITERS.IP]: fakeLimiter(),
      [COLLECTOR_LIMITERS.NODE]: fakeLimiter(),
      [COLLECTOR_LIMITERS.GLOBAL]: fakeLimiter(),
      [COLLECTOR_LIMITERS.READ]: fakeLimiter(),
    },
    now: () => NOW,
  });
  return { memory, app };
}

function uploader(
  buyer: ReturnType<typeof receiptSigner>,
  buffer: ReturnType<typeof createObservationBuffer>,
  fetcher: typeof fetch,
) {
  return createReceiptUploader({
    store: {
      listPending: () => Promise.resolve([]),
      markUploaded: () => Promise.resolve(true),
    },
    nodeId: buyer.nodeId,
    role: P2P_ROLES.BUYER,
    client: {
      kind: RECEIPT_UPLOAD_CLIENTS.BUYER_CLI,
      appVersion: '0.1.0-beta.12',
      platform: RECEIPT_UPLOAD_PLATFORMS.LINUX,
      arch: RECEIPT_UPLOAD_ARCHES.X64,
    },
    signer: buyer.sign,
    url: 'https://collector.test/v1',
    fetch: fetcher,
    now: () => NOW,
    observations: buffer,
  });
}

void test('buyer telemetry reaches the collector as validated observations and leaves the buffer', async () => {
  const buyer = receiptSigner();
  const buffer = createObservationBuffer();
  buffer.sink.emit(unserved(buyer.nodeId));
  buffer.sink.emit(refused(buyer.nodeId));
  const { memory, app } = collector();
  const result = await uploader(buyer, buffer, async (input, init) =>
    app.request(String(input), init),
  ).uploadOnce();
  assert.equal(result.outcome, OUTCOMES.UPLOADED);
  assert.deepEqual(
    memory.observations.map((row) => row.type),
    [TELEMETRY_EVENTS.UNSERVED, TELEMETRY_EVENTS.REFUSED],
  );
  assert.equal(buffer.size(), 0);
});

void test('a failed send puts observations back; a refused batch is dropped and counted', async () => {
  const buyer = receiptSigner();
  const buffer = createObservationBuffer();
  buffer.sink.emit(unserved(buyer.nodeId));
  const down = await uploader(buyer, buffer, () =>
    Promise.resolve(new Response('{}', { status: 503 })),
  ).uploadOnce();
  // An observation failure never puts receipts into backoff; the events wait for the next tick.
  assert.equal(down.outcome, OUTCOMES.IDLE);
  assert.equal(buffer.size(), 1);
  const refusedBatch = await uploader(buyer, buffer, () =>
    Promise.resolve(new Response('{"error":"UPLOAD_POLICY"}', { status: 400 })),
  ).uploadOnce();
  assert.notEqual(refusedBatch.outcome, OUTCOMES.RETRY);
  assert.equal(buffer.size(), 0);
  assert.equal(buffer.dropped(), 1);
});

void test('closing sends the buffered observations of the last requests first', async () => {
  const buyer = receiptSigner();
  const buffer = createObservationBuffer();
  const { memory, app } = collector();
  let posts = 0;
  const up = uploader(buyer, buffer, async (input, init) => {
    posts += 1;
    return app.request(String(input), init);
  });
  // The first tick finds nothing; the request's events arrive before the next 60-second tick.
  up.start();
  buffer.sink.emit(unserved(buyer.nodeId));
  buffer.sink.emit(refused(buyer.nodeId));
  await up.close();
  assert.deepEqual(
    memory.observations.map((row) => row.type),
    [TELEMETRY_EVENTS.UNSERVED, TELEMETRY_EVENTS.REFUSED],
  );
  assert.equal(buffer.size(), 0);
  // Closed for good: no later start sends anything.
  const sent = posts;
  up.start();
  await up.close();
  assert.equal(posts, sent);
});

void test('closing sends every buffered batch, not only the first', async () => {
  const buyer = receiptSigner();
  const buffer = createObservationBuffer();
  const { memory, app } = collector();
  for (let index = 0; index < 250; index += 1)
    buffer.sink.emit(unserved(buyer.nodeId, NOW - 1000 + index));
  await uploader(buyer, buffer, async (input, init) =>
    app.request(String(input), init),
  ).close();
  assert.equal(memory.observations.length, 250);
  assert.equal(buffer.size(), 0);
});

void test('closing gives up within the flush deadline and keeps unsent observations', async () => {
  const buyer = receiptSigner();
  const buffer = createObservationBuffer();
  buffer.sink.emit(unserved(buyer.nodeId));
  // A collector that never answers until the request is aborted.
  const hanging: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new Error('aborted')),
      );
    });
  const started = Date.now();
  await uploader(buyer, buffer, hanging).close();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= RECEIPT_UPLOADER.closeFlushMs - 100);
  assert.ok(elapsed < RECEIPT_UPLOADER.closeFlushMs + 2_000);
  assert.equal(buffer.size(), 1);
});

void test('the buffer is bounded, skips receipts and keeps only validated records', () => {
  const buyer = receiptSigner();
  const buffer = createObservationBuffer(2);
  buffer.sink.emit(unserved(buyer.nodeId, NOW - 3));
  buffer.sink.emit(unserved(buyer.nodeId, NOW - 2));
  buffer.sink.emit(unserved(buyer.nodeId, NOW - 1));
  assert.equal(buffer.size(), 2);
  assert.equal(buffer.dropped(), 1);
  const invalid = { ...unserved(buyer.nodeId), at: -1 };
  const empty = createObservationBuffer();
  empty.sink.emit(invalid);
  assert.equal(empty.size(), 0);
  assert.equal(empty.dropped(), 1);
  const taken = buffer.take(1);
  assert.equal(taken[0]!.at, NOW - 3);
  buffer.restore(taken);
  assert.equal(buffer.take(5).length, 2);
});

void test('observations are on with uploads and can be turned off; receipts cannot', () => {
  const release = { GYBLOS_VERSION: '0.1.0-beta.12' };
  assert.ok(uploadObservationBuffer(release));
  assert.equal(
    uploadObservationBuffer({ ...release, GYBLOS_OBSERVATIONS: 'off' }),
    undefined,
  );
  assert.equal(uploadObservationBuffer({}), undefined);
});
