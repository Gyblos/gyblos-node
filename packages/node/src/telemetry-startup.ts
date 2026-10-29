// Composes optional local telemetry and owns only sinks created by startup, never caller-supplied sinks.
import type { HomeEnvironment, HomeRole } from '@gyblos/config/home';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';

export interface LocalTelemetryOptions {
  enabled: boolean;
  environment: HomeEnvironment;
  role: HomeRole;
  sink?: TelemetrySink;
  createSink?: (options: { environment: HomeEnvironment; role: HomeRole }) => TelemetrySink;
}
export function createLocalTelemetry(options: LocalTelemetryOptions) {
  return {
    sink: options.sink,
    health: () => ({ enabled: false, owned: false, closed: false, failed: false }),
    async close() {},
  };
}
export async function loadLocalTelemetry(_environment: HomeEnvironment, _cwd = process.cwd()) {
  return false;
}
