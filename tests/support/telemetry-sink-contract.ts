// Shared telemetry sink contract; every plugin must preserve fields without leaking unknown content.
import assert from 'node:assert/strict';
import test from 'node:test';

import type { TelemetrySink } from '@gyblos/protocol/telemetry';

import { telemetryEvents } from './receipt-fixture';

export interface TelemetryHarness {
  start(broken?: boolean): Promise<{ sink: TelemetrySink; output(): Promise<string>; cleanup(): Promise<void> }>;
}
export function telemetrySinkContract(name: string, harness: TelemetryHarness) {
  void test(`${name}: all events, privacy, lazy construction and idempotent lifecycle`, async () => {
    const fixture = await harness.start();
    try {
      assert.equal(await fixture.output(), '');
      await fixture.sink.flush();
      assert.equal(await fixture.output(), '');
      for (const event of telemetryEvents()) fixture.sink.emit({ ...event, prompt: 'PROMPT-SECRET-MARKER' } as typeof event);
      await fixture.sink.flush();
      await fixture.sink.flush();
      const output = await fixture.output();
      assert.doesNotMatch(output, /PROMPT-SECRET-MARKER/);
      assert.deepEqual(output.trim().split('\n').map((line) => JSON.parse(line)), telemetryEvents());
      assert.deepEqual(await fixture.sink.close(), { emitted: telemetryEvents().length, dropped: 0, failed: false });
      assert.deepEqual(await fixture.sink.close(), { emitted: telemetryEvents().length, dropped: 0, failed: false });
      await fixture.sink.flush();
    } finally { await fixture.sink.close(); await fixture.cleanup(); }
  });
  void test(`${name}: a broken destination never throws from emit and reports loss`, async () => {
    const fixture = await harness.start(true);
    try {
      assert.doesNotThrow(() => fixture.sink.emit(telemetryEvents()[0]!));
      await fixture.sink.flush();
      const health = await fixture.sink.close();
      assert.ok(health.dropped > 0 || health.failed);
    } finally { await fixture.sink.close(); await fixture.cleanup(); }
  });
  void test(`${name}: close before emit is inert`, async () => {
    const fixture = await harness.start();
    try {
      assert.deepEqual(await fixture.sink.close(), { emitted: 0, dropped: 0, failed: false });
      assert.equal(await fixture.output(), '');
    } finally { await fixture.cleanup(); }
  });
}
