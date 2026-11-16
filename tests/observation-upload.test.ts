// Protects the observation upload envelope: an uploader-signed, bounded batch of content-free
// telemetry event records, detached before any signature check.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CONTROL_CODES, P2P_ROLES } from '@gyblos/protocol/constants';
import { ControlError } from '@gyblos/protocol/control-validation';
import {
  OBSERVATION_UPLOAD,
  signObservationUpload,
  verifyObservationUpload,
  type ObservationUploadV1,
} from '@gyblos/protocol/observation-upload';
import {
  RECEIPT_UPLOAD,
  RECEIPT_UPLOAD_ARCHES,
  RECEIPT_UPLOAD_CLIENTS,
  RECEIPT_UPLOAD_PLATFORMS,
} from '@gyblos/protocol/receipt-upload';

import { receiptSigner } from './support/receipt-fixture';

const T0 = 1_800_000_000_000;

function unserved(buyerNodeId: string) {
  return {
    type: 'unserved',
    at: T0 - 10,
    role: P2P_ROLES.BUYER,
    requestId: null,
    buyerNodeId,
    sellerNodeId: null,
    engineKind: null,
    selection: {
      modelId: 'synthetic/model',
      variant: null,
      quantization: null,
    },
    streaming: true,
  };
}
function upload(nodeId: string, events: unknown[]): ObservationUploadV1 {
  return {
    version: OBSERVATION_UPLOAD.version,
    uploaderNodeId: nodeId,
    role: P2P_ROLES.BUYER,
    client: {
      kind: RECEIPT_UPLOAD_CLIENTS.BUYER_CLI,
      appVersion: '0.1.0-beta.12',
      platform: RECEIPT_UPLOAD_PLATFORMS.LINUX,
      arch: RECEIPT_UPLOAD_ARCHES.X64,
    },
    sentAt: T0,
    nonce: 'ab'.repeat(OBSERVATION_UPLOAD.nonceBytes),
    events: events as Record<string, unknown>[],
  };
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ControlError && error.code === code,
  );
}

void test('a buyer signs a batch of its observations and the collector verifies it', async () => {
  const buyer = receiptSigner();
  const signed = await signObservationUpload(
    upload(buyer.nodeId, [unserved(buyer.nodeId)]),
    buyer.sign,
  );
  assert.deepEqual(
    await verifyObservationUpload(structuredClone(signed)),
    signed,
  );
});

void test('any change after signing fails, and the domain is separate from receipts', async () => {
  const buyer = receiptSigner();
  const signed = await signObservationUpload(
    upload(buyer.nodeId, [unserved(buyer.nodeId)]),
    buyer.sign,
  );
  const tampered = structuredClone(signed);
  tampered.upload.events[0]!.at = T0;
  await rejects(verifyObservationUpload(tampered), CONTROL_CODES.SIGNATURE);
  assert.notEqual(OBSERVATION_UPLOAD.domain, RECEIPT_UPLOAD.domain);
});

void test('envelopes are bounded and strictly shaped', async () => {
  const buyer = receiptSigner();
  const base = upload(buyer.nodeId, [unserved(buyer.nodeId)]);
  for (const bad of [
    { ...base, events: [] },
    {
      ...base,
      events: Array.from({ length: OBSERVATION_UPLOAD.maxEvents + 1 }, () =>
        unserved(buyer.nodeId),
      ),
    },
    { ...base, events: ['text'] },
    { ...base, events: [[1]] },
    {
      ...base,
      client: { ...base.client, kind: RECEIPT_UPLOAD_CLIENTS.SELLER_NODE },
    },
    { ...base, extra: true },
  ])
    await rejects(
      signObservationUpload(bad as ObservationUploadV1, buyer.sign),
      CONTROL_CODES.INVALID,
    );
  await rejects(
    signObservationUpload(
      { ...base, version: 2 } as unknown as ObservationUploadV1,
      buyer.sign,
    ),
    CONTROL_CODES.VERSION,
  );
});

void test('events are detached from the caller before signature checks yield', async () => {
  const buyer = receiptSigner();
  const signed = await signObservationUpload(
    upload(buyer.nodeId, [unserved(buyer.nodeId)]),
    buyer.sign,
  );
  const input = structuredClone(signed);
  const pending = verifyObservationUpload(input);
  input.upload.events[0]!.streaming = false;
  assert.deepEqual(await pending, signed);
});
