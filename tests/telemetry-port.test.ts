// Checks privacy projection and failure isolation of the pure telemetry helpers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { fanOut, toTelemetryRecord } from '@gyblos/core/telemetry';
import {
  TELEMETRY_EVENTS,
  type TelemetrySink,
} from '@gyblos/protocol/telemetry';

import { telemetryEvents } from './support/receipt-fixture';

void test('telemetry allowlist preserves each event and strips nested unknown fields', () => {
  for (const event of telemetryEvents()) {
    assert.deepEqual(toTelemetryRecord(event), event);
    const enriched = JSON.parse(JSON.stringify(event), (key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? { ...value, prompt: 'PROMPT-SECRET-MARKER' }
        : value,
    );
    assert.deepEqual(toTelemetryRecord(enriched), event);
    assert.doesNotMatch(
      JSON.stringify(toTelemetryRecord(enriched)),
      /PROMPT-SECRET-MARKER/,
    );
  }
});
void test('fanOut isolates throwing emit, flush and close and accounts for loss', async () => {
  let received = 0;
  const broken: TelemetrySink = {
    emit() {
      throw new Error('synthetic');
    },
    async flush() {
      throw new Error('synthetic');
    },
    async close() {
      throw new Error('synthetic');
    },
  };
  const good: TelemetrySink = {
    emit() {
      received++;
    },
    async flush() {},
    async close() {
      return { emitted: received, dropped: 0, failed: false };
    },
  };
  const sink = fanOut([broken, good]);
  assert.doesNotThrow(() => sink.emit(telemetryEvents()[0]!));
  assert.equal(received, 1);
  await sink.flush();
  assert.deepEqual(await sink.close(), {
    emitted: 1,
    dropped: 1,
    failed: true,
  });
  assert.deepEqual(await sink.close(), {
    emitted: 1,
    dropped: 1,
    failed: true,
  });
});
void test('telemetry rejects malformed known fields without executing getters or serializers', () => {
  const event = telemetryEvents()[0]!;
  let invoked = false;
  const hostile = {
    toJSON() {
      invoked = true;
      return 'PROMPT-SECRET-MARKER';
    },
  };
  for (const patch of [
    { type: 'PROMPT-SECRET-MARKER' },
    { role: 'PROMPT-SECRET-MARKER' },
    { buyerNodeId: hostile },
    { streaming: hostile },
    { at: Infinity },
  ])
    assert.throws(() =>
      toTelemetryRecord({ ...event, ...patch } as typeof event),
    );
  const getter = { ...event };
  Object.defineProperty(getter, 'buyerNodeId', {
    enumerable: true,
    get() {
      invoked = true;
      return event.buyerNodeId;
    },
  });
  assert.throws(() => toTelemetryRecord(getter));
  assert.equal(invoked, false);
});
void test('refused telemetry requires seller and engine identity to be absent together', () => {
  const event = telemetryEvents().find(
    (event) => event.type === TELEMETRY_EVENTS.REFUSED,
  )!;
  for (const patch of [{ sellerNodeId: null }, { engineKind: null }])
    assert.throws(() =>
      toTelemetryRecord({ ...event, ...patch } as typeof event),
    );
});
void test('receipt telemetry retains signed stop metadata and drops nested unknown content', async () => {
  const { signSellerReceipt } = await import('@gyblos/protocol/receipt');
  const {
    FREE_EXECUTION_CODES,
    FREE_EXECUTION_STOP_REASONS,
    RECEIPT_OUTCOMES,
  } = await import('@gyblos/protocol/constants');
  const { receiptSigner, sellerRecord } =
    await import('./support/receipt-fixture');
  const signer = receiptSigner();
  const record = {
    ...sellerRecord(signer.nodeId),
    outcome: RECEIPT_OUTCOMES.FAILED,
    code: FREE_EXECUTION_CODES.SELLER_CANNOT_CONTINUE,
    reason: FREE_EXECUTION_STOP_REASONS.QUOTA_EXHAUSTED,
    finishReason: null,
  };
  const receipt = { seller: await signSellerReceipt(record, signer.sign) };
  const event = {
    ...telemetryEvents()[0]!,
    type: TELEMETRY_EVENTS.RECEIPT,
    receipt,
  };
  const enriched = {
    ...event,
    receipt: {
      ...receipt,
      seller: {
        ...receipt.seller,
        record: { ...record, prompt: 'PROMPT-SECRET-MARKER' },
      },
    },
  };
  assert.deepEqual(toTelemetryRecord(enriched), event);
});
