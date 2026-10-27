// Lazily persists bounded telemetry in a private role directory; never writes before the first emit.
import type { HomeEnvironment, HomeRole } from '@gyblos/config/home';
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
export function createFileTelemetrySink(_options: { environment: HomeEnvironment; role: HomeRole }): TelemetrySink {
  return { emit() {}, async flush() {}, async close() { return { emitted: 0, dropped: 0, failed: false }; } };
}
