// Shared telemetry sink contract; every plugin must preserve fields without leaking unknown content.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { TelemetrySink } from '@gyblos/protocol/telemetry';

import { telemetryEvents } from './receipt-fixture';

export interface TelemetryHarness {
  start(broken?: boolean): Promise<{
    sink: TelemetrySink;
    output(): Promise<string>;
    assertInert(): Promise<void>;
    cleanup(): Promise<void>;
  }>;
}
async function withoutTimers<T>(
  context: TestContext,
  work: () => Promise<T>,
): Promise<T> {
  let timers = 0;
  const unexpectedTimer = () => {
    timers++;
    throw new Error('Unexpected telemetry timer before emit');
  };
  context.mock.method(globalThis, 'setTimeout', unexpectedTimer);
  context.mock.method(globalThis, 'setInterval', unexpectedTimer);
  try {
    const result = await work();
    assert.equal(timers, 0);
    return result;
  } finally {
    context.mock.restoreAll();
  }
}
async function inertStart(context: TestContext, harness: TelemetryHarness) {
  return withoutTimers(context, async () => {
    const fixture = await harness.start();
    try {
      await fixture.sink.flush();
      await fixture.assertInert();
      return fixture;
    } catch (error) {
      await fixture.sink.close();
      await fixture.cleanup();
      throw error;
    }
  });
}
export function telemetrySinkContract(name: string, harness: TelemetryHarness) {
  void test(`${name}: all events, privacy, lazy construction and idempotent lifecycle`, async (context) => {
    const fixture = await inertStart(context, harness);
    try {
      assert.equal(await fixture.output(), '');
      await fixture.sink.flush();
      assert.equal(await fixture.output(), '');
      for (const event of telemetryEvents()) {
        const enriched = { ...event, prompt: 'PROMPT-SECRET-MARKER' };
        fixture.sink.emit(enriched);
      }
      await fixture.sink.flush();
      await fixture.sink.flush();
      const output = await fixture.output();
      assert.doesNotMatch(output, /PROMPT-SECRET-MARKER/);
      assert.deepEqual(
        output
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
        telemetryEvents(),
      );
      assert.deepEqual(await fixture.sink.close(), {
        emitted: telemetryEvents().length,
        dropped: 0,
        failed: false,
      });
      assert.deepEqual(await fixture.sink.close(), {
        emitted: telemetryEvents().length,
        dropped: 0,
        failed: false,
      });
      await fixture.sink.flush();
    } finally {
      await fixture.sink.close();
      await fixture.cleanup();
    }
  });
  void test(`${name}: a broken destination never throws from emit and reports loss`, async () => {
    const fixture = await harness.start(true);
    try {
      assert.doesNotThrow(() => fixture.sink.emit(telemetryEvents()[0]!));
      await fixture.sink.flush();
      const health = await fixture.sink.close();
      assert.ok(health.dropped > 0 || health.failed);
    } finally {
      await fixture.sink.close();
      await fixture.cleanup();
    }
  });
  void test(`${name}: close before emit is inert`, async (context) => {
    const fixture = await inertStart(context, harness);
    try {
      assert.deepEqual(
        await withoutTimers(context, () => fixture.sink.close()),
        {
          emitted: 0,
          dropped: 0,
          failed: false,
        },
      );
      assert.equal(await fixture.output(), '');
      await fixture.assertInert();
    } finally {
      await fixture.cleanup();
    }
  });
}
