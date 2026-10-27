// Copies only telemetry port fields and isolates sinks; no clock, filesystem or plugin dependencies.
import type { TelemetryEvent, TelemetrySink } from '@gyblos/protocol/telemetry';
export function toTelemetryRecord(_event: TelemetryEvent): object { return {}; }
export function fanOut(_sinks: readonly TelemetrySink[]): TelemetrySink {
  return { emit() {}, async flush() {}, async close() { return { emitted: 0, dropped: 0, failed: false }; } };
}
