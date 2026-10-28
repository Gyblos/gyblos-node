// Captures synthetic local telemetry and exposes a deterministic clock; no services, keys or files.
import type { TelemetryEvent, TelemetrySink } from '@gyblos/protocol/telemetry';

export function localTelemetry() {
  const events: TelemetryEvent[] = [];
  let now = 1700000000000;
  const sink: TelemetrySink = {
    emit(event) {
      events.push(event);
    },
    async flush() {},
    async close() {
      return { emitted: events.length, dropped: 0, failed: false };
    },
  };
  return {
    sink,
    events,
    now: () => now,
    advance: (value: number) => {
      now += value;
    },
  };
}
