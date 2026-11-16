// Exercises POST /v1/observations over memory and SQLite-backed D1 storage: events are validated by
// core, bound to their uploader and role, stored in one bounded batch, and receipts are refused here.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLLECTOR_ERRORS,
  COLLECTOR_LIMITS,
  COLLECTOR_ROUTES,
} from '@gyblos/metrics-collector/constants';
import { createD1Storage } from '@gyblos/metrics-collector/storage-d1';
import { createMemoryStorage } from '@gyblos/metrics-collector/storage-memory';
import { P2P_ROLES } from '@gyblos/protocol/constants';
import {
  OBSERVATION_UPLOAD,
  signObservationUpload,
  type ObservationUploadV1,
} from '@gyblos/protocol/observation-upload';
import {
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
} from '@gyblos/protocol/receipt-upload';

import { responseJson, testCollector } from './support/metrics-collector';
import { createCollectorD1 } from './support/metrics-collector-d1';
import { receiptSigner } from './support/receipt-fixture';
import { T0 } from './support/receipt-upload';

const SELECTION = {
  modelId: 'synthetic/model',
  variant: null,
  quantization: null,
};
const unserved = (buyerNodeId: string, at = T0 - 10) => ({
  type: 'unserved',
  at,
  role: P2P_ROLES.BUYER,
  requestId: null,
  buyerNodeId,
  sellerNodeId: null,
  engineKind: null,
  selection: SELECTION,
  streaming: true,
});
const refused = (buyerNodeId: string) => ({
  type: 'refused',
  at: T0 - 5,
  role: P2P_ROLES.BUYER,
  requestId: '33'.repeat(16),
  buyerNodeId,
  sellerNodeId: null,
  engineKind: null,
  selection: SELECTION,
  streaming: false,
  refusal: 'connect_failed',
});

function envelope(nodeId: string, events: unknown[]): ObservationUploadV1 {
  return {
    version: OBSERVATION_UPLOAD.version,
    uploaderNodeId: nodeId,
    role: P2P_ROLES.BUYER,
    client: {
      kind: RECEIPT_UPLOAD_CLIENTS.BUYER_DESKTOP,
      appVersion: '0.1.0-beta.12',
      platform: RECEIPT_UPLOAD_PLATFORMS.MACOS,
      arch: RECEIPT_UPLOAD_ARCHES.ARM64,
    },
    sentAt: T0,
    nonce: 'ab'.repeat(OBSERVATION_UPLOAD.nonceBytes),
    events: events as Record<string, unknown>[],
  };
}
async function postObservations(
  post: ReturnType<typeof testCollector>['app'],
  body: unknown,
) {
  return post.request(
    `https://collector.test${COLLECTOR_ROUTES.OBSERVATIONS}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

void test('a buyer uploads unserved demand and refusals, stored with their own times', async () => {
  const memory = createMemoryStorage();
  const { app } = testCollector(memory.storage);
  const buyer = receiptSigner();
  const signed = await signObservationUpload(
    envelope(buyer.nodeId, [unserved(buyer.nodeId), refused(buyer.nodeId)]),
    buyer.sign,
  );
  assert.deepEqual(await responseJson(await postObservations(app, signed)), {
    status: 200,
    body: { receivedAt: T0, accepted: 2 },
  });
  assert.deepEqual(
    memory.observations.map((row) => [row.type, row.at, row.requestId]),
    [
      ['unserved', T0 - 10, null],
      ['refused', T0 - 5, '33'.repeat(16)],
    ],
  );
  assert.equal(memory.envelopes[0]!.kind, 'observations');
});

void test("an uploader cannot send another node's events, another role's, invalid ones or receipts", async () => {
  const { app } = testCollector(createMemoryStorage().storage);
  const buyer = receiptSigner();
  const other = receiptSigner();
  const cases: [unknown[], string][] = [
    [[unserved(other.nodeId)], COLLECTOR_ERRORS.UPLOAD_POLICY],
    [
      [{ ...unserved(buyer.nodeId), role: P2P_ROLES.SELLER }],
      COLLECTOR_ERRORS.UPLOAD_POLICY,
    ],
    [
      [{ ...unserved(buyer.nodeId), type: 'teleported' }],
      COLLECTOR_ERRORS.INVALID_UPLOAD,
    ],
    [
      [{ ...unserved(buyer.nodeId), prompt: 'hello' }],
      COLLECTOR_ERRORS.INVALID_UPLOAD,
    ],
  ];
  for (const [events, code] of cases) {
    const signed = await signObservationUpload(
      envelope(buyer.nodeId, events),
      buyer.sign,
    );
    assert.deepEqual(
      (await responseJson(await postObservations(app, signed))).body,
      {
        error: code,
      },
    );
  }
});

void test('a full batch is one envelope write plus chunked observation inserts in one transaction', async () => {
  const database = createCollectorD1();
  const { app } = testCollector(createD1Storage(database));
  const buyer = receiptSigner();
  const events = Array.from(
    { length: OBSERVATION_UPLOAD.maxEvents },
    (_, index) => unserved(buyer.nodeId, T0 - index),
  );
  const signed = await signObservationUpload(
    envelope(buyer.nodeId, events),
    buyer.sign,
  );
  assert.equal((await postObservations(app, signed)).status, 200);
  assert.equal(
    database.rows('SELECT * FROM collector_observations').length,
    OBSERVATION_UPLOAD.maxEvents,
  );
  const batched = database.log.filter((entry) => entry.kind === 'batch');
  // 1 envelope + ceil(200 / 10) observation chunks (10 columns under the 100-parameter limit).
  assert.equal(
    batched.length,
    1 + Math.ceil(OBSERVATION_UPLOAD.maxEvents / 10),
  );
  for (const entry of database.log)
    assert.ok(entry.params.length <= COLLECTOR_LIMITS.maxBoundParameters);
  // A replay stores nothing more.
  assert.equal((await postObservations(app, signed)).status, 409);
  assert.equal(
    database.rows('SELECT * FROM collector_observations').length,
    OBSERVATION_UPLOAD.maxEvents,
  );
});

void test('a re-sent event is stored once, and events outside the time window are refused', async () => {
  const database = createCollectorD1();
  const { app } = testCollector(createD1Storage(database));
  const buyer = receiptSigner();
  const first = await signObservationUpload(
    envelope(buyer.nodeId, [unserved(buyer.nodeId)]),
    buyer.sign,
  );
  const again = await signObservationUpload(
    {
      ...envelope(buyer.nodeId, [unserved(buyer.nodeId)]),
      nonce: 'cd'.repeat(16),
    },
    buyer.sign,
  );
  assert.equal((await postObservations(app, first)).status, 200);
  assert.equal((await postObservations(app, again)).status, 200);
  assert.equal(database.rows('SELECT * FROM collector_observations').length, 1);

  for (const at of [
    T0 + COLLECTOR_LIMITS.clockWindowMs + 1,
    T0 - COLLECTOR_LIMITS.maxObservationAgeMs - 1,
  ]) {
    const signed = await signObservationUpload(
      {
        ...envelope(buyer.nodeId, [unserved(buyer.nodeId, at)]),
        nonce: 'ef'.repeat(16),
      },
      buyer.sign,
    );
    assert.deepEqual(
      (await responseJson(await postObservations(app, signed))).body,
      {
        error: COLLECTOR_ERRORS.INVALID_UPLOAD,
      },
    );
  }
});
