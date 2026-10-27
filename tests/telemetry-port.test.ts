// Checks privacy projection and failure isolation of the pure telemetry helpers.
import assert from 'node:assert/strict';
import test from 'node:test';

import { fanOut, toTelemetryRecord } from '@gyblos/core/telemetry';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';

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
