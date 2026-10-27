// Operator telemetry through injected output only; no global console or lifecycle on import.
import type { TelemetrySink } from '@gyblos/protocol/telemetry';
export function createConsoleTelemetrySink(_options: { write: (line: string) => void }): TelemetrySink {
  return { emit() {}, async flush() {}, async close() { return { emitted: 0, dropped: 0, failed: false }; } };
}
