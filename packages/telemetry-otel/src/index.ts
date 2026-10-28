// Implements an explicitly owned metrics sink; never starts node services or global instrumentation.
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
export interface OtelTelemetryOptions { exporter: PushMetricExporter }
export function createOtelTelemetrySink(_options: OtelTelemetryOptions): TelemetrySink {
  return { emit() {}, async flush() {}, async close() { return { emitted: 0, dropped: 0, failed: false }; } };
}
